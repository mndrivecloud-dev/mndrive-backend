// server.js — Render usado SOMENTE para: pedir o código no Telegram e confirmar o login.
// Upload, download e exclusão de arquivos ficam 100% no Supabase (feito pelo navegador).
// Instalar: npm i express cors telegram
const express = require("express");
const cors = require("cors");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { computeCheck } = require("telegram/Password");

const app = express();
app.use(cors()); // depois restrinja para o domínio onde o mndrive.html está hospedado
app.use(express.json());

const TTL = 10 * 60 * 1000; // o código pendente expira em 10 min
const pending = new Map();  // phone -> { client, phoneCodeHash, timer }

function drop(phone) {
  const p = pending.get(phone);
  if (!p) return;
  clearTimeout(p.timer);
  p.client.disconnect().catch(() => {});
  pending.delete(phone);
}

app.get("/", (_req, res) => res.send("ok")); // health check do Render

// 1) Pede o código: o Telegram envia a mensagem com o código para o app do usuário
app.post("/api/auth/send-code", async (req, res) => {
  const { apiId, apiHash, phone } = req.body || {};
  if (!apiId || !apiHash || !phone) {
    return res.json({ success: false, message: "Preencha API ID, API Hash e telefone." });
  }
  try {
    drop(phone);
    const client = new TelegramClient(new StringSession(""), Number(apiId), apiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    const { phoneCodeHash } = await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
    pending.set(phone, { client, phoneCodeHash, timer: setTimeout(() => drop(phone), TTL) });
    res.json({ success: true, phoneCodeHash });
  } catch (err) {
    console.error("send-code:", err.errorMessage || err.message);
    res.json({ success: false, message: err.errorMessage || err.message });
  }
});

// 2) Confirma o código (e a senha 2FA, se houver). Não guarda nem devolve a sessão do Telegram.
app.post("/api/auth/sign-in", async (req, res) => {
  const { phone, code, password } = req.body || {};
  const p = pending.get(phone);
  if (!p) {
    return res.json({ success: false, message: "Pedido expirado. Envie o código de novo." });
  }
  const { client, phoneCodeHash } = p;
  try {
    try {
      await client.invoke(
        new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: String(code) })
      );
    } catch (err) {
      if (err.errorMessage !== "SESSION_PASSWORD_NEEDED") throw err;
      if (!password) {
        return res.json({ success: false, needsPassword: true, message: "Conta com verificação em duas etapas: envie a senha." });
      }
      const pwd = await client.invoke(new Api.account.GetPassword());
      await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) }));
    }
    drop(phone); // login confirmado: descarta a conexão
    res.json({ success: true });
  } catch (err) {
    console.error("sign-in:", err.errorMessage || err.message);
    res.json({ success: false, message: err.errorMessage || err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Auth API no ar"));
