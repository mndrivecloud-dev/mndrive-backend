const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
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
        
        // Utiliza o método nativo do cliente GramJS para enviar o código de forma segura
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

        // Utiliza o método nativo .signIn() do GramJS que lida com o hash interno do cliente
        await client.signIn({
            phoneNumber: phone,
            phoneCode: async () => code,
            onError: (err) => { throw err; },
        });

        const savedSession = client.session.save();
        await client.disconnect();
        delete activeClients[phone];

        res.json({ success: true, session: savedSession });
    } catch (error) {
        console.error("Erro em sign-in:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
