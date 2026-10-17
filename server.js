const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

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
        
        const result = await client.sendCode(
            {
                apiId: Number(apiId),
                apiHash: apiHash,
            },
            phone,
            false
        );

        activeClients[phone] = { client, phoneCodeHash: result.phoneCodeHash };

        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        console.error("Erro em send-code:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 2: Valida o código utilizando o método client.signIn do GramJS e cria o canal
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code } = req.body;

        const sessionData = activeClients[phone];
        if (!sessionData) {
            return res.json({ success: false, message: "Sessão expirada. Solicite um novo código." });
        }

        const { client, phoneCodeHash } = sessionData;

        // Submete o código de login utilizando o método oficial do cliente GramJS
        await client.signIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
        });

        // Verifica e cria o canal MNDRIVE CLOUD se não existir
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
