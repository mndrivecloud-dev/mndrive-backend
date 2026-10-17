const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const multer = require('multer');
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
        
        const client = new TelegramClient(new StringSession(""), Number(apiId), apiHash, {
            connectionRetries: 5,
        });

        await client.connect();
        
        const result = await client.invoke(
            new Api.auth.SendCode({
                phoneNumber: phone,
                apiId: Number(apiId),
                apiHash: apiHash,
                settings: new Api.CodeSettings({
                    allowFlashcall: false,
                    currentNumber: true,
                    allowAppHash: true,
                }),
            })
        );

        activeClients[phone] = { client, phoneCodeHash: result.phoneCodeHash };

        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        console.error("Erro em send-code:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 2: Valida o código utilizando estritamente client.invoke(new Api.auth.SignIn)
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
            client = new TelegramClient(new StringSession(""), Number(apiId), apiHash, {
                connectionRetries: 5,
            });
            await client.connect();
        }

        // Chamada oficial MTProto via invoke que elimina qualquer erro de função inexistente
        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash || req.body.phoneCodeHash,
                phoneCode: code,
            })
        );

        // Verifica e cria automaticamente o canal MNDRIVE CLOUD se ele não existir
        let channelId = null;
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
            console.error("Aviso ao gerir o canal MNDRIVE CLOUD:", channelErr);
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

// Rota 3: Upload de ficheiros para o canal MNDRIVE CLOUD
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const { apiId, apiHash, sessionString, channelId } = req.body;
        const file = req.file;

        if (!file) {
            return res.json({ success: false, message: "Nenhum ficheiro enviado." });
        }

        const client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, { connectionRetries: 5 });
        await client.connect();

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
