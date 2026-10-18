const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fileUpload = require('express-fileupload');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(fileUpload());

const activeClients = {};

// Configuração de Fingerprint realista para evitar detecção de script/bot (Antidetect)
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

// Rota 2: Sign-in e verificação/criação do canal MNDRIVE CLOUD
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

        // Procura ou cria o canal MNDRIVE CLOUD
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

// Rota 3: Upload de Ficheiros para o Canal MNDRIVE CLOUD via GramJS (Com Antidetect Fingerprint)
app.post('/api/upload', async (req, res) => {
    let tempPath = null;
    try {
        const { phone, channelId, apiId, apiHash } = req.body;
        const uploadedFile = req.files?.file;

        if (!uploadedFile) {
            return res.json({ success: false, message: "Nenhum arquivo enviado." });
        }

        let clientData = activeClients[phone];
        let client = clientData?.client;

        // Se o cliente não estiver conectado na memória, reconecta aplicando as opções de Antidetect
        if (!client || !client.connected) {
            const sessionString = clientData?.sessionString || "";
            
            if (!apiId || !apiHash) {
                return res.json({ success: false, message: "Credenciais da API em falta para reconexão." });
            }

            client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, getClientOptions());
            await client.connect();
            activeClients[phone] = { client, sessionString };
        }

        // Salva temporariamente o arquivo no servidor para envio
        tempPath = `./temp_${Date.now()}_${uploadedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        await uploadedFile.mv(tempPath);

        // Envia o ficheiro para o canal do Telegram sem delay (direto)
        const result = await client.sendFile(channelId, {
            file: tempPath,
            caption: `MNDRIVE UPLOAD: ${uploadedFile.name}`
        });

        // Limpa o ficheiro temporário do servidor
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

// Rota 4: Excluir Ficheiro / Mensagem do Canal MNDRIVE CLOUD via GramJS
app.post('/api/delete', async (req, res) => {
    try {
        const { phone, channelId, messageId, apiId, apiHash } = req.body;

        if (!messageId || !channelId || !phone) {
            return res.json({ success: false, message: "Parâmetros em falta para exclusão." });
        }

        let clientData = activeClients[phone];
        let client = clientData?.client;

        // Se o cliente não estiver conectado na memória, reconecta com o fingerprint antidetect
        if (!client || !client.connected) {
            const sessionString = clientData?.sessionString || "";
            
            if (!apiId || !apiHash) {
                return res.json({ success: false, message: "Credenciais da API em falta para reconexão." });
            }

            client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, getClientOptions());
            await client.connect();
            activeClients[phone] = { client, sessionString };
        }

        // Converte o channelId e o messageId para o formato numérico correto do GramJS
        const peer = Number(channelId);
        const msgIdNum = Number(messageId);

        // Apaga a mensagem diretamente no canal do Telegram usando a API User
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
