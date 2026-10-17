const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());
app.use(cors());

// Rota 1: Envia o código de login para o Telegram do usuário
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;
        
        // Cria uma sessão temporária limpa
        const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
        });

        await client.connect();
        
        // Envia o código via Telegram API oficial
        const result = await client.sendCode(
            {
                apiId: Number(apiId),
                apiHash: apiHash,
            },
            phone,
            false
        );

        await client.disconnect();

        // Retorna o hash necessário para a próxima etapa de confirmação
        res.json({ success: true, phoneCodeHash: result.phoneCodeHash });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: error.message });
    }
});

// Rota 2: Valida o código digitado e gera a string de sessão permanente
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { apiId, apiHash, phone, code, phoneCodeHash } = req.body;

        const stringSession = new StringSession("");
        const client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
        });

        await client.connect();

        await client.signIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
        });

        // Salve esta stringSession se quiser manter a conta conectada permanentemente no backend
        const savedSession = client.session.save();

        await client.disconnect();

        res.json({ success: true, session: savedSession });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
