const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const multer = require('multer'); // Necessário para receber ficheiros no Express
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(cors());

const activeClients = {};

app.get('/', (req, res) => {
    res.send('MNDRIVE Backend Online');
});

// Rota 1: Envia o código de login
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

// Rota 2: Valida o código e cria/localiza o canal MNDRIVE CLOUD
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code, apiId, apiHash } = req.body;
        const sessionData = activeClients[phone];
        
        let client;
        let phoneCodeHash;

        if (sessionData) {
            client = sessionData.client;
            phoneCodeHash = sessionData.phoneCodeHash;
        } else {
            // Caso recrie o cliente se a memória limpou
            client = new TelegramClient(new StringSession(""), Number(apiId), apiHash, { connectionRetries: 5 });
            await client.connect();
        }

        await client.signIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
        });

        let channelId = null;
        let channelUsername = null;
        try {
            const dialogs = await client.getDialogs();
            let mndriveChannel = dialogs.find(d => d.isChannel && d.title === "MNDRIVE CLOUD");

            if (!mndriveChannel) {
                const created = await client.invoke(
                    new Api.channels.CreateChannel({
                        title: "MNDRIVE CLOUD",
                        about: "Canal oficial de armazenamento em nuvem do MNDRIVE Quantum Cloud.",
                        megagroup: false,
                    })
                );
                const update = created.chats[0];
                channelId = update.id.toString();
            } else {
                channelId = mndriveChannel.id.toString();
            }
        } catch (channelErr) {
            console.error("Aviso ao gerir o canal:", channelErr);
        }

        const savedSession = client.session.save();
        await client.disconnect();
        delete activeClients[phone];

        res.json({ success: true, session: savedSession, channelId });
    } catch (error) {
        console.error("Erro em sign-in:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 3: Faz o upload do ficheiro diretamente para o canal do Telegram do utilizador
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const { apiId, apiHash, sessionString, channelId } = req.body;
        const file = req.file;

        if (!file) {
            return res.json({ success: false, message: "Nenhum ficheiro enviado." });
        }

        const client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, { connectionRetries: 5 });
        await client.connect();

        // Envia o ficheiro para o canal MNDRIVE CLOUD utilizando o canal ID ou entidade
        const uploadedFile = await client.sendFile(channelId || 'me', {
            file: file.buffer,
            workers: 2,
            fileSize: file.size,
            attributes: [
                new Api.DocumentAttributeFilename({ fileName: file.originalname })
            ]
        });

        const messageId = uploadedFile.id;
        await client.disconnect();

        res.json({ success: true, messageId });
    } catch (error) {
        console.error("Erro no upload:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
