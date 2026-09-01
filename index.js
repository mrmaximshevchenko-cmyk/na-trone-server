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
// Недельный рейтинг по числу сеансов (текущая календарная неделя, пн–вс)
app.get('/leaderboard/week', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.user_id, u.username, u.first_name, u.avatar, COUNT(*) AS count
      FROM sessions s
      INNER JOIN users u ON u.user_id = s.user_id
      WHERE to_timestamp(s.id / 1000.0) >= date_trunc('week', NOW())
      GROUP BY s.user_id, u.username, u.first_name, u.avatar
      ORDER BY count DESC
      LIMIT 100
    `)
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Месячный рейтинг по лучшему стрику (текущий календарный месяц)
app.get('/leaderboard/month', async (req, res) => {
  try {
    // Берём все сеансы за текущий месяц вместе с данными юзеров
    const result = await pool.query(`
      SELECT s.user_id, s.id, u.username, u.first_name, u.avatar
      FROM sessions s
      INNER JOIN users u ON u.user_id = s.user_id
      WHERE to_timestamp(s.id / 1000.0) >= date_trunc('month', NOW())
    `)

    // Группируем по юзеру
    const byUser = {}
    for (const row of result.rows) {
      if (!byUser[row.user_id]) {
        byUser[row.user_id] = {
          user_id: row.user_id,
          username: row.username,
          first_name: row.first_name,
          avatar: row.avatar,
          ids: [],
        }
      }
      byUser[row.user_id].ids.push(Number(row.id))
    }

    // Считаем лучший стрик (максимум дней подряд) в этом месяце
    const dayKey = (ms) => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    }
    const bestStreak = (ids) => {
      const days = [...new Set(ids.map(dayKey))]
        .map((k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m, d).getTime() })
        .sort((a, b) => a - b)
      if (days.length === 0) return 0
      let best = 1, run = 1
      for (let i = 1; i < days.length; i++) {
        const diff = (days[i] - days[i - 1]) / 86400000
        if (diff === 1) { run++; if (run > best) best = run } else if (diff > 1) run = 1
      }
      return best
    }

    const list = Object.values(byUser).map((u) => ({
      user_id: u.user_id,
      username: u.username,
      first_name: u.first_name,
      avatar: u.avatar,
      streak: bestStreak(u.ids),
    }))
    list.sort((a, b) => b.streak - a.streak)
    res.json(list.slice(0, 100))
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Поиск юзера по нику (username), без статистики
app.get('/search/:nick', async (req, res) => {
  try {
    const nick = req.params.nick.replace(/^@/, '').toLowerCase()
    const result = await pool.query(
      `SELECT user_id, username, first_name, avatar
       FROM users
       WHERE LOWER(username) = $1
       LIMIT 10`,
      [nick]
    )
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