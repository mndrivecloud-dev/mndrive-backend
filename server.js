const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());
app.use(fileUpload());

const activeClients = {};

// Configuração do Supabase no Backend
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ybrxlijhhhrsrhrllpok.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_pQ7dfAc9p3C1MEgnez6oHg_IjhJFhK9';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const getClientOptions = () => ({
    connectionRetries: 5,
    deviceModel: 'Desktop PC',
    systemVersion: 'Windows 11 Pro',
    appVersion: '4.8.9 x64',
    langCode: 'en',
    systemLangCode: 'en-US'
});

app.get('/', (req, res) => {
    res.send('MNDRIVE Backend Online');
});

// Função auxiliar para recuperar a session_string da memória ou do Supabase de forma segura
async function getOrRestoreClient(phone, apiId, apiHash) {
    // 1. Se já estiver na memória e conectado, reutiliza
    if (activeClients[phone] && activeClients[phone].client && activeClients[phone].client.connected) {
        return activeClients[phone].client;
    }

    let sessionString = activeClients[phone]?.sessionString || "";

    // 2. Se não estiver na memória, busca no Supabase pelo número de telefone
    if (!sessionString) {
        try {
            const { data, error } = await supabase
                .from('mndrive_sessions') // Tabela dedicada para guardar as sessões
                .select('session_string')
                .eq('phone', phone)
                .maybeSingle();
            
            if (data && data.session_string) {
                sessionString = data.session_string;
                console.log("Sessão recuperada com sucesso do Supabase para:", phone);
            }
        } catch (e) {
            console.error("Erro ao consultar sessão no Supabase:", e);
        }
    }

    // 3. Cria e conecta o cliente Telegram com a sessão recuperada
    const client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, getClientOptions());
    await client.connect();
    
    activeClients[phone] = { client, sessionString };
    return client;
}

// Rota 1: Enviar código de autenticação
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;
        const client = new TelegramClient(new StringSession(""), Number(apiId), apiHash, getClientOptions());
        await client.connect();
        
        const result = await client.sendCode({ apiId: Number(apiId), apiHash: apiHash }, phone, false);
        activeClients[phone] = { client, phoneCodeHash: result.phoneCodeHash };

        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        console.error("Erro em send-code:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 2: Sign-in e salvamento persistente da sessão no Supabase
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        const sessionData = activeClients[phone];
        if (!sessionData) {
            return res.json({ success: false, message: "Sessão expirada. Solicite um novo código." });
        }

        const { client } = sessionData;

        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash || sessionData.phoneCodeHash,
                phoneCode: code,
            })
        );

        const dialogs = await client.getDialogs();
        let targetChannel = dialogs.find(d => d.title === "MNDRIVE CLOUD" && d.isChannel);

        if (!targetChannel) {
            const createResult = await client.invoke(
                new Api.channels.CreateChannel({
                    title: "MNDRIVE CLOUD",
                    about: "Canal oficial de armazenamento em nuvem do MNDRIVE Quantum Cloud.",
                    megagroup: false,
                })
            );
            const createdChat = createResult.chats[0];
            targetChannel = { id: createdChat.id };
        }

        const savedSession = client.session.save();
        activeClients[phone] = { client, sessionString: savedSession };

        // PERSISTÊNCIA NO SUPABASE: Salva a session_string para nunca mais perder após reiniciar o Render
        try {
            await supabase
                .from('mndrive_sessions')
                .upsert({ phone: phone, session_string: savedSession, updated_at: new Date() }, { onConflict: ['phone'] });
            console.log("Sessão salva com sucesso no Supabase para o telemóvel:", phone);
        } catch (dbErr) {
            console.error("Aviso: Não foi possível salvar a sessão no Supabase:", dbErr.message);
        }

        res.json({ 
            success: true, 
            session: savedSession, 
            channelId: targetChannel.id.toString() 
        });
    } catch (error) {
        console.error("Erro em sign-in:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 3: Upload de Ficheiros Otimizado e Acelerado
app.post('/api/upload', async (req, res) => {
    let tempPath = null;
    try {
        const { phone, channelId, apiId, apiHash } = req.body;
        const uploadedFile = req.files?.file;

        if (!uploadedFile) {
            return res.json({ success: false, message: "Nenhum arquivo enviado." });
        }

        if (!apiId || !apiHash || !phone) {
            return res.json({ success: false, message: "Credenciais da API ou telefone em falta para reconexão." });
        }

        const client = await getOrRestoreClient(phone, Number(apiId), apiHash);

        // Caminho temporário único
        tempPath = `./temp_${Date.now()}_${uploadedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        
        // Grava de forma assíncrona otimizada
        await uploadedFile.mv(tempPath);

        // Configuração otimizada para evitar o travamento nos 99%
        const result = await client.sendFile(channelId, {
            file: tempPath,
            caption: `MNDRIVE UPLOAD: ${uploadedFile.name}`,
            workers: 8, // Aumentado de 4 para 8 para acelerar o envio e processamento dos blocos
            clearDraft: true,
            partSizeKb: 512, // Tamanho padrão seguro para blocos no Telegram
            progressCallback: (progress) => {
                // Aqui você pode monitorar se necessário
                const percent = Math.round(progress * 100);
                if (percent % 20 === 0) {
                    console.log(`Progresso MTProto: ${percent}%`);
                }
            }
        });

        // Limpeza imediata do disco do Render para liberar espaço e I/O
        if (tempPath && fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }

        res.json({ 
            success: true, 
            messageId: result.id,
            fileId: result.media?.document?.id?.toString() || 'file_uploaded'
        });
    } catch (error) {
        console.error("Erro detalhado no upload:", error);
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch(e) {}
        }
        res.json({ success: false, message: error.message });
    }
});

// Rota 4: Excluir Ficheiro
app.post('/api/delete', async (req, res) => {
    try {
        const { phone, channelId, messageId, apiId, apiHash } = req.body;

        if (!messageId || !channelId || !phone) {
            return res.json({ success: false, message: "Parâmetros em falta para exclusão." });
        }

        if (!apiId || !apiHash) {
            return res.json({ success: false, message: "Credenciais da API em falta para reconexão." });
        }

        const client = await getOrRestoreClient(phone, Number(apiId), apiHash);

        const peer = Number(channelId);
        const msgIdNum = Number(messageId);

        await client.invoke(
            new Api.channels.DeleteMessages({
                channel: peer,
                id: [msgIdNum],
            })
        );

        res.json({ success: true, message: "Mensagem apagada do Telegram com sucesso!" });
    } catch (error) {
        console.error("Erro ao apagar mensagem no Telegram:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
