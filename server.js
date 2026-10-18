const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Configurações do Express
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(cors());
app.use(fileUpload({
    limits: { fileSize: 500 * 1024 * 1024 },
    useTempFile: true,
    tempFileDir: '/tmp/'
}));

const activeClients = {};

// INICIALIZAÇÃO CORRETA DO SUPABASE (Certifique-se de que estas linhas existem e estão antes de qualquer função)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ybrxlijhhhrsrhrllpok.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_pQ7dfAc9p3C1MEgnez6oHg_IjhJFhK9';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const getClientOptions = () => ({
    connectionRetries: 5,
    useWSS: false,
    deviceModel: 'Desktop PC',
    systemVersion: 'Windows 11 Pro',
    appVersion: '4.8.9 x64',
    langCode: 'en',
    systemLangCode: 'en-US'
});

app.get('/', (req, res) => {
    res.send('MNDRIVE Backend Online');
});

async function getOrRestoreClient(phone, apiId, apiHash) {
    if (activeClients[phone] && activeClients[phone].client && activeClients[phone].client.connected) {
        return activeClients[phone].client;
    }

    let sessionString = activeClients[phone]?.sessionString || "";

    if (!sessionString) {
        try {
            const { data } = await supabase
                .from('mndrive_sessions')
                .select('session_string')
                .eq('phone', phone)
                .maybeSingle();
            
            if (data && data.session_string) {
                sessionString = data.session_string;
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
        } catch (dbErr) {
            console.error("Aviso Supabase:", dbErr.message);
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

// Rota 3: Upload Tradicional de Ficheiros
app.post('/api/upload', async (req, res) => {
    let tempPath = null;
    try {
        const { phone, channelId, apiId, apiHash } = req.body;
        const uploadedFile = req.files?.file;

        if (!uploadedFile) {
            return res.status(400).json({ success: false, message: "Nenhum arquivo enviado." });
        }

        const client = await getOrRestoreClient(phone, Number(apiId), apiHash);

        tempPath = uploadedFile.tempFilePath || `./temp_${Date.now()}_${uploadedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        
        if (!uploadedFile.tempFilePath) {
            await uploadedFile.mv(tempPath);
        }

        const result = await client.sendFile(channelId, {
            file: tempPath,
            caption: `MNDRIVE: ${uploadedFile.name}`,
            workers: 8,
            clearDraft: true
        });

        if (tempPath && fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }

        return res.json({ 
            success: true, 
            messageId: result.id,
            fileId: result.media?.document?.id?.toString() || 'file_uploaded'
        });
    } catch (error) {
        console.error("Erro crítico na rota /api/upload:", error);
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch(e) {}
        }
        return res.status(500).json({ success: false, message: error.message || "Erro interno no servidor." });
    }
});

// NOVA ROTA: Upload otimizado via Supabase Storage (Navegador -> Supabase -> Telegram)
app.post('/api/upload-from-supabase', async (req, res) => {
    let tempPath = null;
    try {
        const { phone, channelId, apiId, apiHash, fileUrl, fileName } = req.body;

        if (!fileUrl || !phone) {
            return res.status(400).json({ success: false, message: "URL do ficheiro em falta." });
        }

        const client = await getOrRestoreClient(phone, Number(apiId), apiHash);

        tempPath = `./temp_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

        const writer = fs.createWriteStream(tempPath);
        const downloadResponse = await axios({
            url: fileUrl,
            method: 'GET',
            responseType: 'stream'
        });

        downloadResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const result = await client.sendFile(channelId, {
            file: tempPath,
            caption: `MNDRIVE: ${fileName}`,
            workers: 8,
            clearDraft: true
        });

        if (tempPath && fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }

        return res.json({ 
            success: true, 
            messageId: result.id,
            fileId: result.media?.document?.id?.toString() || 'file_uploaded'
        });
    } catch (error) {
        console.error("Erro no upload via Supabase:", error);
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch(e) {}
        }
        return res.status(500).json({ success: false, message: error.message || "Erro interno no servidor." });
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

        const msgIdNum = Number(messageId);
        let rawChannelId = String(channelId);
        const entity = await client.getEntity(rawChannelId);

        await client.deleteMessages(entity, [msgIdNum], { revoke: true });

        res.json({ success: true, message: "Mensagem apagada do Telegram com sucesso!" });
    } catch (error) {
        console.error("Erro ao apagar mensagem no Telegram:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});

// CORREÇÃO 2: Aumentar o timeout global do servidor HTTP para evitar queda em uploads compridos (ex: 10 minutos)
server.timeout = 600000;
server.keepAliveTimeout = 600000;
