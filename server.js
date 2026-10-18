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

app.get('/', (req, res) => {
    res.send('MNDRIVE Backend Online');
});

// Rota 1: Enviar código
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;
        const client = new TelegramClient(new StringSession(""), Number(apiId), apiHash, { connectionRetries: 5 });
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
        const { phone, code } = req.body;
        const sessionData = activeClients[phone];
        if (!sessionData) {
            return res.json({ success: false, message: "Sessão expirada. Solicite um novo código." });
        }

        const { client, phoneCodeHash } = sessionData;

        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
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
        
        // Guarda a sessão ativa em memória associada ao telefone
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

// Rota 3: Upload de Ficheiros para o Canal MNDRIVE CLOUD via GramJS
app.post('/api/upload', async (req, res) => {
    try {
        const { phone, channelId, apiId, apiHash } = req.body;
        const uploadedFile = req.files?.file;

        if (!uploadedFile) {
            return res.json({ success: false, message: "Nenhum arquivo enviado." });
        }

        let clientData = activeClients[phone];
        let client = clientData?.client;

        // Se o cliente não estiver conectado na memória, reconecta usando a StringSession salva
        if (!client || !client.connected) {
            const sessionString = clientData?.sessionString || "";
            
            if (!apiId || !apiHash) {
                return res.json({ success: false, message: "Credenciais da API em falta para reconexão." });
            }

            client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, { connectionRetries: 5 });
            await client.connect();
            activeClients[phone] = { client, sessionString };
        }

        // Salva temporariamente o arquivo no servidor para envio
        const tempPath = `./temp_${Date.now()}_${uploadedFile.name}`;
        await uploadedFile.mv(tempPath);

        // Envia o ficheiro para o canal do Telegram
        const result = await client.sendFile(channelId, {
            file: tempPath,
            caption: `MNDRIVE UPLOAD: ${uploadedFile.name}`
        });

        // Limpa o ficheiro temporário do servidor
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }

        res.json({ 
            success: true, 
            messageId: result.id,
            fileId: result.media?.document?.id?.toString() || 'file_uploaded'
        });
    } catch (error) {
        console.error("Erro no upload:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
