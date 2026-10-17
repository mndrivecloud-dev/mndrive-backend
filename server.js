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

app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code } = req.body;

        const sessionData = activeClients[phone];
        if (!sessionData) {
            return res.json({ success: false, message: "Sessão expirada. Solicite um novo código." });
        }

        const { client } = sessionData;

        await client.signIn({
            phoneNumber: phone,
            phoneCode: async () => code,
            onError: (err) => { throw err; },
        });

        // ==========================================
        // VERIFICA E CRIA O CANAL MNDRIVE CLOUD SE NÃO EXISTIR
        // ==========================================
        let channelId = null;
        try {
            const dialogs = await client.getDialogs();
            let mndriveChannel = dialogs.find(d => d.isChannel && d.title === "MNDRIVE CLOUD");

            if (!mndriveChannel) {
                // Cria o canal se ele não existir
                const created = await client.invoke(
                    new Api.channels.CreateChannel({
                        title: "MNDRIVE CLOUD",
                        about: "Canal oficial de armazenamento em nuvem do MNDRIVE Quantum Cloud.",
                        megagroup: false, // Define como canal de broadcast (canal normal)
                    })
                );
                
                // Extrai o ID do canal recém-criado
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
