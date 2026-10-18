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
    useWSS: false, // Força a conexão TCP direta com encapsulamento TLS na porta 443
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
    if (activeClients[phone] && activeClients[phone].client && activeClients[phone].client.connected) {
        return activeClients[phone].client;
    }

    let sessionString = activeClients[phone]?.sessionString || "";

    if (!sessionString) {
        try {
            const { data, error } = await supabase
                .from('mndrive_sessions')
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

// Rota 3: Upload de Ficheiros Otimizado e Acelerado via Porta TLS 443
app.post('/api/upload', async (req, res) => {
    let tempPath = null;
    try {
        const { phone, channelId, apiId, apiHash } = req.body;
        const uploadedFile = req.files?.file;

        if (!uploadedFile) {
            return res.json({ success: false, message: "Nenhum arquivo enviado." });
        }

        const client = await getOrRestoreClient(phone, Number(apiId), apiHash);

        // Caminho temporário estrito na memória/disco efêmero do Render
        tempPath = `./temp_${Date.now()}_${uploadedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        await uploadedFile.mv(tempPath);

        // Envio nativo rápido do Node.js para o canal MNDRIVE CLOUD
        const result = await client.sendFile(channelId, {
            file: tempPath,
            caption: `MNDRIVE: ${uploadedFile.name}`,
            workers: 8, // Paralelismo máximo para ir instantâneo
            clearDraft: true
        });

        if (tempPath && fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }

        res.json({ 
            success: true, 
            messageId: result.id,
            fileId: result.media?.document?.id?.toString() || 'file_uploaded'
        });
    } catch (error) {
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch(e) {}
        }
        res.json({ success: false, message: error.message });
    }
});

// Rota 4: Excluir Ficheiro (Com permissões totais de gestão de mensagens)
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

        const msgIdNum = Number(messageId);
        let rawChannelId = String(channelId);

        // Remove o prefixo '-100' se houver para formatar corretamente para a API do GramJS caso necessário, 
        // ou utiliza a entidade convertida diretamente pelo cliente.
        const entity = await client.getEntity(rawChannelId);

        // Utiliza o método nativo de exclusão de mensagens do canal/grupo com privilégios totais da conta
        await client.deleteMessages(entity, [msgIdNum], { revoke: true });

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
