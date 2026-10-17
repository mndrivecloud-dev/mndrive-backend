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

// Rota 2: Valida o código, verifica se o canal MNDRIVE CLOUD existe e cria apenas se necessário
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code } = req.body;

        const sessionData = activeClients[phone];
        if (!sessionData) {
            return res.json({ success: false, message: "Sessão expirada. Solicite um novo código." });
        }

        const { client, phoneCodeHash } = sessionData;

        // Autentica o código
        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: code,
            })
        );

        // Verifica os diálogos/canais existentes na conta
        const dialogs = await client.getDialogs();
        let targetChannel = dialogs.find(d => d.title === "MNDRIVE CLOUD" && d.isChannel);

        // Se o canal não existir, cria-o automaticamente
        if (!targetChannel) {
            const createResult = await client.invoke(
                new Api.channels.CreateChannel({
                    title: "MNDRIVE CLOUD",
                    about: "Canal oficial de armazenamento em nuvem do MNDRIVE Quantum Cloud.",
                    megagroup: false,
                })
            );
            
            // Extrai o ID ou username do canal criado para sincronização
            const createdChat = createResult.chats[0];
            targetChannel = { id: createdChat.id };
        }

        const savedSession = client.session.save();
        await client.disconnect();
        delete activeClients[phone];

        res.json({ 
            success: true, 
            session: savedSession, 
            channelId: targetChannel ? targetChannel.id : null 
        });
    } catch (error) {
        console.error("Erro em sign-in:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
});
