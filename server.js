const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());
app.use(cors());

// Rota de teste inicial
app.get('/', (req, res) => {
    res.send('MNDRIVE Backend Online');
});

// Rota 1: Envia o código de login para o Telegram do usuário
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

        await client.disconnect();

        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        console.error("Erro em send-code:", error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 2: Valida o código digitado usando a função invoke (método oficial MTProto para sign in)
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { apiId, apiHash, phone, code, phoneCodeHash } = req.body;

        const stringSession = new StringSession("");
        const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
            connectionRetries: 5,
        });

        await client.connect();

        // Utiliza o método direto da API do Telegram (auth.signIn) através do invoke do GramJS
        const result = await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: code,
            })
        );

        const savedSession = client.session.save();
        await client.disconnect();

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
