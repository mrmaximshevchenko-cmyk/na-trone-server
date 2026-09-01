const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

// Подключение к базе (строка берётся из .env)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// Создаём таблицу сеансов, если её ещё нет
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      rating INTEGER,
      amount TEXT,
      consistency TEXT,
      sheets INTEGER,
      no_paper BOOLEAN,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  console.log('Таблица sessions готова ✅')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      avatar TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)
  console.log('Таблица users готова ✅')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id)
    )
  `)
  console.log('Таблица follows готова ✅')
}

// Тестовый маршрут
app.get('/', (req, res) => {
  res.json({ message: 'Сервер На троне работает! 👑' })
})

// Проверка связи с базой
app.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()')
    res.json({ ok: true, time: result.rows[0].now })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Сохранить сеанс
app.post('/sessions', async (req, res) => {
  try {
    const { id, user_id, rating, amount, consistency, sheets, no_paper } = req.body
    await pool.query(
      `INSERT INTO sessions (id, user_id, rating, amount, consistency, sheets, no_paper)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, user_id, rating, amount, consistency, sheets, no_paper]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Получить историю пользователя
app.get('/sessions/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY id DESC',
      [req.params.userId]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Зарегистрировать / обновить пользователя (при входе)
app.post('/user', async (req, res) => {
  try {
    const { user_id, username, first_name, avatar } = req.body
    await pool.query(
      `INSERT INTO users (user_id, username, first_name, avatar, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         avatar = EXCLUDED.avatar,
         updated_at = NOW()`,
      [user_id, username, first_name, avatar]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Временный: посмотреть всех юзеров (для проверки)
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT user_id, username, first_name, avatar FROM users ORDER BY updated_at DESC')
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// ===== Telegram: ответ на /start =====
const BOT_TOKEN = process.env.BOT_TOKEN
const APP_URL = 'https://na-trone-app.onrender.com'

app.post('/webhook', async (req, res) => {
  try {
    const msg = req.body.message
    if (msg && msg.text && msg.text.startsWith('/start')) {
      const chatId = msg.chat.id
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'Добро пожаловать на трон, Ваше Величество!',
          reply_markup: {
            inline_keyboard: [[
              { text: 'Занять трон 👑', web_app: { url: APP_URL } }
            ]]
          }
        }),
      })
    }
    res.sendStatus(200)
  } catch (err) {
    console.log('Ошибка webhook:', err.message)
    res.sendStatus(200)
  }
})

const PORT = process.env.PORT || 3001

app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT} 🚀`)
  try {
    await initDb()
  } catch (err) {
    console.log('Ошибка базы:', err.message)
  }
})