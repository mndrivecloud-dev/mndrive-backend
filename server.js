const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());
app.use(cors());

// Armazena temporariamente os clientes ativos por número de telefone
const activeClients = {};

app.get('/', (req, res) => {
    res.send('MNDRIVE Backend Online');
});

// Rota 1: Envia o código e guarda a sessão do cliente em memória
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;
        
        const stringSession = new StringSession("");
        const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
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

        // Guarda o cliente ativo para ser reutilizado no sign-in
        activeClients[phone] = { client, phoneCodeHash: result.phoneCodeHash };

        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        console.error("Erro em send-code:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 2: Utiliza exatamente o mesmo cliente que enviou o código
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
