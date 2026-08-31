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
const PORT = process.env.PORT || 3001

app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT} 🚀`)
  try {
    await initDb()
  } catch (err) {
    console.log('Ошибка базы:', err.message)
  }
})