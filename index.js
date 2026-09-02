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
      is_private BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `)
  // На случай если таблица уже была — добавим колонку
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE`)
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
        AND u.is_private = FALSE
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
        AND u.is_private = FALSE
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
       WHERE LOWER(username) = $1 AND is_private = FALSE
       LIMIT 10`,
      [nick]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Добавить в друзья (взаимно — обе записи)
app.post('/follow', async (req, res) => {
  try {
    const { me, target } = req.body
    if (!me || !target || me === target) return res.json({ ok: false })
    await pool.query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [me, target]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Удалить из друзей (обе записи)
app.post('/unfollow', async (req, res) => {
  try {
    const { me, target } = req.body
    await pool.query(
      `DELETE FROM follows WHERE (follower_id = $1 AND following_id = $2)
       OR (follower_id = $2 AND following_id = $1)`,
      [me, target]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Список друзей юзера (с их данными)
app.get('/friends/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.username, u.first_name, u.avatar
       FROM follows f
       INNER JOIN users u ON u.user_id = f.following_id
       WHERE f.follower_id = $1
       ORDER BY u.username`,
      [req.params.userId]
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Рейтинг среди друзей (+ сам юзер) — неделя по сеансам
app.get('/leaderboard/week/friends/:userId', async (req, res) => {
  try {
    const uid = req.params.userId
    const result = await pool.query(`
      SELECT s.user_id, u.username, u.first_name, u.avatar, COUNT(*) AS count
      FROM sessions s
      INNER JOIN users u ON u.user_id = s.user_id
      WHERE to_timestamp(s.id / 1000.0) >= date_trunc('week', NOW())
        AND (s.user_id = $1 OR s.user_id IN (
          SELECT following_id FROM follows WHERE follower_id = $1
        ))
      GROUP BY s.user_id, u.username, u.first_name, u.avatar
      ORDER BY count DESC
      LIMIT 100
    `, [uid])
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Рейтинг среди друзей (+ сам юзер) — месяц по стрикам
app.get('/leaderboard/month/friends/:userId', async (req, res) => {
  try {
    const uid = req.params.userId
    const result = await pool.query(`
      SELECT s.user_id, s.id, u.username, u.first_name, u.avatar
      FROM sessions s
      INNER JOIN users u ON u.user_id = s.user_id
      WHERE to_timestamp(s.id / 1000.0) >= date_trunc('month', NOW())
        AND (s.user_id = $1 OR s.user_id IN (
          SELECT following_id FROM follows WHERE follower_id = $1
        ))
    `, [uid])

    const byUser = {}
    for (const row of result.rows) {
      if (!byUser[row.user_id]) {
        byUser[row.user_id] = {
          user_id: row.user_id, username: row.username,
          first_name: row.first_name, avatar: row.avatar, ids: [],
        }
      }
      byUser[row.user_id].ids.push(Number(row.id))
    }
    const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
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
      user_id: u.user_id, username: u.username, first_name: u.first_name,
      avatar: u.avatar, streak: bestStreak(u.ids),
    }))
    list.sort((a, b) => b.streak - a.streak)
    res.json(list.slice(0, 100))
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Статистика конкретного юзера (для чужого профиля)
app.get('/stats/:userId', async (req, res) => {
  try {
    const uid = req.params.userId
    // Данные юзера
    const userRes = await pool.query(
      'SELECT user_id, username, first_name, avatar FROM users WHERE user_id = $1',
      [uid]
    )
    if (userRes.rows.length === 0) return res.json({ ok: false })
    // Все его сеансы
    const sessRes = await pool.query(
      'SELECT rating, consistency, no_paper, sheets, id FROM sessions WHERE user_id = $1',
      [uid]
    )
    const sessions = sessRes.rows
    const total = sessions.length
    const rated = sessions.filter((s) => s.rating > 0)
    const avg = rated.length > 0
      ? (rated.reduce((a, s) => a + s.rating, 0) / rated.length).toFixed(1)
      : '—'
    const totalSheets = sessions.reduce((a, s) => a + (s.no_paper ? 0 : s.sheets), 0)

    // Лучший стрик за всё время
    const dayKey = (ms) => { const d = new Date(Number(ms)); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
    const days = [...new Set(sessions.map((s) => dayKey(s.id)))]
      .map((k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m, d).getTime() })
      .sort((a, b) => a - b)
    let bestStreak = days.length > 0 ? 1 : 0, run = 1
    for (let i = 1; i < days.length; i++) {
      const diff = (days[i] - days[i - 1]) / 86400000
      if (diff === 1) { run++; if (run > bestStreak) bestStreak = run } else if (diff > 1) run = 1
    }

    res.json({
      ok: true,
      user: userRes.rows[0],
      total, avg, totalSheets, bestStreak,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Переключить приватность
app.post('/privacy', async (req, res) => {
  try {
    const { user_id, is_private } = req.body
    await pool.query('UPDATE users SET is_private = $2 WHERE user_id = $1', [user_id, is_private])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Отправить юзеру картинку ачивки (для шаринга)
app.post('/share-achievement', async (req, res) => {
  try {
    const { chat_id, ach_id, ach_name } = req.body
    const imageUrl = `${APP_URL}/ach-memes/${ach_id}.jpg`
    const caption = `🏆 Новое достижение на троне: «${ach_name}»!\n\nGo за мной 👑`
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id,
        photo: imageUrl,
        caption,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Занять трон 👑', url: 'https://t.me/natrone_bot/throne' }
          ]]
        }
      }),
    })
    res.json({ ok: true })
  } catch (err) {
    console.log('Ошибка отправки картинки:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})
// ===== Telegram: ответ на /start =====
const BOT_TOKEN = process.env.BOT_TOKEN
const APP_URL = 'https://na-trone-app.onrender.com'

app.post('/webhook', async (req, res) => {
  try {
    // Инлайн-запрос (шаринг ачивки картинкой)
    const inlineQuery = req.body.inline_query
    if (inlineQuery) {
      const achId = inlineQuery.query.trim()
      // Названия ачивок (id -> имя) для подписи
      const ACH_NAMES = {
        first: 'Первое приземление', five: 'Пятёрочка', ten: 'Десятка сходов',
        hundred: 'Центурион', perfect: 'Идеальный дроп', paperking: 'Бумажный король',
        ecoguard: 'Страж природы', survival: 'Режим выживания', aqua: 'Аквавоин',
        earlybird: 'Ранняя пташка', midnight: 'Полуночник', double: 'Дубль',
        hattrick: 'Хет-трик', streak3: 'Разогрев', streak7: 'Неделя дисциплины',
        loose: 'Прорыв плотины', hard: 'Каменная кладка', sausage10: 'Идеальная форма',
        spectrum: 'Полный спектр', artillery: 'Тяжёлая артиллерия',
      }
      const achName = ACH_NAMES[achId] || achId
      const results = []
      if (achId) {
        const imageUrl = `${APP_URL}/ach-memes/${achId}.jpg`
        results.push({
          type: 'photo',
          id: achId,
          photo_url: imageUrl,
          thumbnail_url: imageUrl,
          caption: `🏆 Новое достижение на троне: «${achName}»! 💩 Кто больше?`,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Занять трон 👑', url: 'https://t.me/natrone_bot/throne' }
            ]]
          }
        })
      }
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerInlineQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inline_query_id: inlineQuery.id,
          results,
          cache_time: 0,
        }),
      })
      return res.sendStatus(200)
    }

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