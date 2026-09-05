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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_friends BOOLEAN DEFAULT TRUE`)
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coins (
      user_id TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0,
      coins_onboarded BOOLEAN DEFAULT FALSE
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coin_log (
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, reason)
    )
  `)
  await pool.query(`ALTER TABLE coins ADD COLUMN IF NOT EXISTS selected_skin TEXT`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owned_skins (
      user_id TEXT NOT NULL,
      skin_id TEXT NOT NULL,
      bought_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, skin_id)
    )
  `)
  console.log('Таблицы coins, coin_log, owned_skins готовы ✅')
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
    // Уведомить друзей (не блокируя ответ)
    notifyFriendsAboutSession(user_id, id)
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
// Тихо отправить юзеру картинку полученной ачивки в чат с ботом
app.post('/notify-achievement', async (req, res) => {
  try {
    const { chat_id, ach_id, ach_name } = req.body
    // Только эти 10 «весёлых» ачивок шлём в чат
    const ALLOWED = ['first','paperking','perfect','survival','streak3','hattrick','alien','clean','rollercoaster','goat']
    if (!ALLOWED.includes(ach_id)) return res.json({ ok: true, skipped: true })

    const imageUrl = `${APP_URL}/ach-memes/${ach_id}.jpg`
    const caption = `🏆 Новое достижение: «${ach_name}»! 👑`
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id,
        photo: imageUrl,
        caption,
        disable_notification: true,
      }),
    })
    res.json({ ok: true })
  } catch (err) {
    console.log('Ошибка уведомления об ачивке:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})
// Вкл/выкл уведомления о друзьях
app.post('/notify-setting', async (req, res) => {
  try {
    const { user_id, notify } = req.body
    await pool.query('UPDATE users SET notify_friends = $2 WHERE user_id = $1', [user_id, notify])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Тексты уведомлений о друзьях (рандом)
const FRIEND_NOTIFS = [
  'Милорд, ваш подданный {друг} только что встал с трона. А вы когда соизволите? 👑',
  '👑 {друг} исполнил свой королевский долг. Не отставайте, Ваше Величество!',
  '💩 {друг} только что покорил трон. Престол ждёт и вас!',
  'Внимание, двор! {друг} совершил визит на трон. Ваш ход, монарх 👑',
  '🚽 {друг} отметился на престоле. А ваш трон пылится?',
  'Милорд, {друг} опережает вас на один поход. Терпимо ли это? 🔥',
  'Слухи по королевству: {друг} сходил на трон. Пора и вам, Ваше Величество 💩',
  '🔔 {друг} занял престол. Корона зовёт и вас!',
  '{друг} совершил великое дело на троне. А чем похвастаетесь вы? 👑',
  '💩 Пока вы медлите, {друг} уже покорил трон. Догоняйте!',
  'Ваше Величество, {друг} только что отрёкся от трона (временно). Престол свободен! 👑',
  '🚽 {друг} справил королевскую нужду. Не пора ли и вам на аудиенцию?',
  'Депеша из уборной: {друг} на троне. Ваш престол скучает 👑',
  '🔥 {друг} вырвался вперёд одним походом. Так и будете смотреть?',
  '👑 Придворные шепчутся: {друг} снова на троне. Составите компанию?',
  '{друг} совершил акт державной важности на троне. Ваш выход, монарх! 💩',
  'Милорд, {друг} только что короновался на фарфоровом престоле. Не отставайте 👑',
]

// Уведомить друзей о походе (первый за день)
async function notifyFriendsAboutSession(authorId, sessionId) {
  try {
    // Автор приватный? Не анонсируем
    const authorRes = await pool.query('SELECT username, first_name, is_private FROM users WHERE user_id = $1', [authorId])
    if (authorRes.rows.length === 0) return
    const author = authorRes.rows[0]
    if (author.is_private) return

    // Кто подписан на автора (его друзья) и у кого включены уведомления
    const friendsRes = await pool.query(
      `SELECT u.user_id FROM follows f
       INNER JOIN users u ON u.user_id = f.follower_id
       WHERE f.following_id = $1 AND u.notify_friends = TRUE`,
      [authorId]
    )

    const authorName = author.username || author.first_name || 'Кто-то'
    for (const row of friendsRes.rows) {
      const chatId = row.user_id.replace('tg_', '')
      if (!/^\d+$/.test(chatId)) continue // только реальные tg-id
      const text = FRIEND_NOTIFS[Math.floor(Math.random() * FRIEND_NOTIFS.length)].replace('{друг}', authorName)
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: { inline_keyboard: [[{ text: 'Занять трон 👑', web_app: { url: APP_URL } }]] },
        }),
      })
    }
  } catch (err) {
    console.log('Ошибка уведомления друзей:', err.message)
  }
}
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
        alien: 'Контакт с иным разумом', nightwatch: 'Страж ночи', doomsday: 'Судный день',
        clean: 'Чистая работа', rollercoaster: 'Американские горки', roadworks: 'Дорожные работы',
        jackpot: 'Джекпот', prophecy: 'Пророчество сбылось', dragon: 'Победитель дракона',
        ninja: 'Бесшумный ниндзя', blackstreak: 'Чёрная полоса', goat: 'Величайший из всех',
        thirty: 'Ритуал полнолуния', timeless: 'Вне времени', zen: 'Мастер дзена',
        reader: 'Конец есть!',
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
// ===== МАГАЗИН СКИНОВ =====

// Конфиг скинов. tier: common/rare/epic/legendary/mythic. free: бесплатные (текущие авы)
// Добавить новый скин = просто дописать сюда + залить картинку в public/skins/{id}.jpg
const SKINS = [
  // Бесплатные (текущие аватарки) — цена 0, тир free
  { id: 'king', tier: 'free', price: 0 },
  { id: 'gym', tier: 'free', price: 0 },
  { id: 'cool', tier: 'free', price: 0 },
  { id: 'gamer', tier: 'free', price: 0 },
  { id: 'zen', tier: 'free', price: 0 },
  // ЗАГЛУШКИ для теста разных тиров (потом заменим на реальные скины)
  { id: 'test_common', tier: 'common', price: 400 },
  { id: 'test_rare', tier: 'rare', price: 1200 },
  { id: 'test_epic', tier: 'epic', price: 3500 },
  { id: 'test_legendary', tier: 'legendary', price: 7000 },
  { id: 'test_mythic', tier: 'mythic', price: 13000 },
]

const TIER_ORDER = { free: 0, common: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 }

// Отдать магазин: скины + что куплено + баланс + выбранный
app.get('/shop/:userId', async (req, res) => {
  try {
    const uid = req.params.userId
    const bal = await pool.query('SELECT balance, selected_skin FROM coins WHERE user_id = $1', [uid])
    const owned = await pool.query('SELECT skin_id FROM owned_skins WHERE user_id = $1', [uid])
    const ownedIds = owned.rows.map(r => r.skin_id)
    res.json({
      balance: bal.rows[0]?.balance || 0,
      selected: bal.rows[0]?.selected_skin || 'king',
      owned: ownedIds,
      skins: SKINS,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Купить скин (проверка баланса на сервере — защита)
app.post('/buy-skin', async (req, res) => {
  try {
    const { user_id, skin_id } = req.body
    const skin = SKINS.find(s => s.id === skin_id)
    if (!skin) return res.json({ ok: false, error: 'no_skin' })
    if (skin.tier === 'free') return res.json({ ok: false, error: 'free' })

    // Уже куплен?
    const own = await pool.query('SELECT 1 FROM owned_skins WHERE user_id = $1 AND skin_id = $2', [user_id, skin_id])
    if (own.rows.length > 0) return res.json({ ok: false, error: 'owned' })

    // Хватает ли монет?
    const bal = await pool.query('SELECT balance FROM coins WHERE user_id = $1', [user_id])
    const balance = bal.rows[0]?.balance || 0
    if (balance < skin.price) return res.json({ ok: false, error: 'not_enough', balance })

    // Списываем + записываем владение
    await pool.query('UPDATE coins SET balance = balance - $2 WHERE user_id = $1', [user_id, skin.price])
    await pool.query('INSERT INTO owned_skins (user_id, skin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user_id, skin_id])
    res.json({ ok: true, balance: balance - skin.price })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Выбрать активный скин (должен быть бесплатным или купленным)
app.post('/select-skin', async (req, res) => {
  try {
    const { user_id, skin_id } = req.body
    const skin = SKINS.find(s => s.id === skin_id)
    if (!skin) return res.json({ ok: false, error: 'no_skin' })
    if (skin.tier !== 'free') {
      const own = await pool.query('SELECT 1 FROM owned_skins WHERE user_id = $1 AND skin_id = $2', [user_id, skin_id])
      if (own.rows.length === 0) return res.json({ ok: false, error: 'not_owned' })
    }
    await pool.query(
      `INSERT INTO coins (user_id, selected_skin) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET selected_skin = $2`,
      [user_id, skin_id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
const PORT = process.env.PORT || 3001
// ===== ЭКОНОМИКА: КАКАКОИНЫ =====

// Сколько монет за каждую ачивку
const ACH_COINS = {
  // Лёгкие обычные — 50
  first: 50, five: 50, aqua: 50, loose: 50, earlybird: 50, midnight: 50,
  // Средние обычные — 100
  ten: 100, ecoguard: 100, survival: 100, paperking: 100, double: 100, streak3: 100, hard: 100, artillery: 100,
  // Сложные обычные — 200
  perfect: 200, hattrick: 200, streak7: 200, sausage10: 200, spectrum: 200, hundred: 200,
  // Обычные секретки — 300
  alien: 300, nightwatch: 300, jackpot: 300, roadworks: 300, blackstreak: 300,
  clean: 300, rollercoaster: 300, ninja: 300, thirty: 300, timeless: 300, reader: 300,
  // Хардкорные секретки — 500
  doomsday: 500, prophecy: 500, dragon: 500, goat: 500, zen: 500,
}

const OLDBIE_BONUS = 500 // бонус старожила

// --- Логика ачивок на сервере (проверка по истории) ---
function achDayKey(ms) { const d = new Date(Number(ms)); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
function achHour(ms) { return new Date(Number(ms)).getHours() }
function achMaxPerDay(h) {
  const map = {}; h.forEach(s => { const k = achDayKey(s.id); map[k] = (map[k]||0)+1 }); return Math.max(0, ...Object.values(map))
}
function achStreak(h) {
  if (!h.length) return 0
  const days = new Set(h.map(s => achDayKey(s.id)))
  let streak = 0; const c = new Date()
  if (!days.has(achDayKey(c.getTime()))) c.setDate(c.getDate()-1)
  while (days.has(achDayKey(c.getTime()))) { streak++; c.setDate(c.getDate()-1) }
  return streak
}
function achHasStreakOf(h, n, test) {
  const arr = [...h].sort((a,b)=>a.id-b.id); let c = 0
  for (const s of arr) { if (test(s)) { c++; if (c>=n) return true } else c = 0 }
  return false
}
function achAllDayparts(h) {
  let m=false,d=false,e=false,n=false
  h.forEach(s => { const x=achHour(s.id); if(x>=5&&x<12)m=true; else if(x>=12&&x<18)d=true; else if(x>=18&&x<23)e=true; else n=true })
  return m&&d&&e&&n
}

// Возвращает список id выполненных ачивок по истории (h: массив сессий из БД)
function getUnlockedServer(h) {
  const S = h.map(r => ({ id: Number(r.id), rating: r.rating, amount: r.amount, consistency: r.consistency, sheets: r.sheets, noPaper: r.no_paper }))
  const ids = []
  const add = (id, cond) => { if (cond) ids.push(id) }
  const some = (fn) => S.some(fn)
  add('first', S.length>=1); add('five', S.length>=5); add('ten', S.length>=10); add('hundred', S.length>=100)
  add('perfect', some(s=>s.rating===10&&s.consistency==='Колбаска'))
  add('paperking', some(s=>!s.noPaper&&s.sheets>10))
  add('ecoguard', some(s=>!s.noPaper&&s.sheets>0&&s.sheets<=2))
  add('survival', some(s=>!s.noPaper&&s.sheets===1))
  add('aqua', some(s=>s.noPaper))
  add('earlybird', some(s=>achHour(s.id)>=5&&achHour(s.id)<7))
  add('midnight', some(s=>achHour(s.id)>=0&&achHour(s.id)<5))
  add('double', achMaxPerDay(S)>=2); add('hattrick', achMaxPerDay(S)>=3)
  add('streak3', achStreak(S)>=3); add('streak7', achStreak(S)>=7)
  add('loose', some(s=>s.consistency==='Жидко')); add('hard', some(s=>s.consistency==='Сухари'))
  add('sausage10', S.filter(s=>s.consistency==='Колбаска').length>=10)
  add('spectrum', ['Жидко','Мягко','Колбаска','Сухари'].every(c=>some(s=>s.consistency===c)))
  add('artillery', S.filter(s=>s.amount==='Куча').length>=3)
  add('alien', some(s=>s.rating===1))
  add('nightwatch', some(s=>achHour(s.id)>=2&&achHour(s.id)<4))
  add('doomsday', achMaxPerDay(S)>=5)
  add('clean', some(s=>s.rating===10&&s.noPaper))
  add('jackpot', some(s=>{const d=new Date(s.id);return d.getHours()===0&&d.getMinutes()<10}))
  add('prophecy', achHasStreakOf(S,7,s=>s.rating===7))
  add('dragon', some(s=>s.amount==='Куча'&&!s.noPaper&&s.sheets>10))
  add('ninja', S.filter(s=>s.noPaper).length>=5)
  add('blackstreak', achHasStreakOf(S,3,s=>s.rating>=1&&s.rating<=3))
  add('goat', achHasStreakOf(S,10,s=>s.rating>=8))
  add('thirty', S.length>=30)
  add('timeless', achAllDayparts(S))
  add('zen', achHasStreakOf(S,3,s=>s.rating===10))
  return ids
}

// Начислить монеты (с защитой от повтора через coin_log)
async function grantCoins(userId, reason, amount) {
  try {
    const ins = await pool.query(
      `INSERT INTO coin_log (user_id, reason, amount) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, reason) DO NOTHING RETURNING amount`,
      [userId, reason, amount]
    )
    if (ins.rows.length > 0) {
      await pool.query(
        `INSERT INTO coins (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = coins.balance + $2`,
        [userId, amount]
      )
      return amount
    }
    return 0
  } catch (err) { console.log('grantCoins err:', err.message); return 0 }
}

// Пересчитать и доначислить монеты юзеру (ачивки + бонус старожила)
async function recalcCoins(userId) {
  const sess = await pool.query('SELECT id, rating, amount, consistency, sheets, no_paper FROM sessions WHERE user_id = $1', [userId])
  const unlocked = getUnlockedServer(sess.rows)
  for (const achId of unlocked) {
    const amount = ACH_COINS[achId] || 0
    if (amount > 0) await grantCoins(userId, 'ach_' + achId, amount)
  }
  // Бонус старожила — всем, у кого есть хоть одна сессия
  if (sess.rows.length > 0) await grantCoins(userId, 'oldbie_bonus', OLDBIE_BONUS)
}

// Получить баланс и разбивку
app.get('/coins/:userId', async (req, res) => {
  try {
    await recalcCoins(req.params.userId)
    const bal = await pool.query('SELECT balance, coins_onboarded FROM coins WHERE user_id = $1', [req.params.userId])
    const log = await pool.query('SELECT reason, amount FROM coin_log WHERE user_id = $1', [req.params.userId])
    res.json({
      balance: bal.rows[0]?.balance || 0,
      onboarded: bal.rows[0]?.coins_onboarded || false,
      log: log.rows,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Отметить, что онбординг монет показан
app.post('/coins-onboarded', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO coins (user_id, coins_onboarded) VALUES ($1, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET coins_onboarded = TRUE`,
      [req.body.user_id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})
app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT} 🚀`)
  try {
    await initDb()
  } catch (err) {
    console.log('Ошибка базы:', err.message)
  }
})