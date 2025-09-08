/**
 * Samaced Backend (Final GitHub-ready)
 */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { format } = require('date-fns');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const DB_FILE = path.join(__dirname, 'data.sqlite');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const db = new sqlite3.Database(DB_FILE);
function runAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function allAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function(err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function getAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function(err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helpers
function formatBalance(amount) {
  return "₵" + (Number(amount).toFixed(2));
}
function formatDate(dt) {
  try {
    return format(new Date(dt), "dd MMM yyyy, h:mm a");
  } catch(e) {
    return dt;
  }
}
function addStudentFields(s) {
  return {
    id: s.id,
    admission_no: s.admission_no,
    label: `${s.name} (${s.class})`,
    value: s.name,
    name: s.name,
    class: s.class,
    guardian: s.guardian,
    balance: formatBalance(s.balance || 0),
    status: (s.balance > 0 ? "Overdue" : "Cleared")
  };
}
function addPaymentFields(p) {
  return {
    id: p.id,
    student_id: p.student_id,
    amount: formatBalance(p.amount),
    method: (p.method || "").toString().charAt(0).toUpperCase() + (p.method || "").toString().slice(1),
    note: p.note,
    payer_name: p.payer_name,
    created_at: formatDate(p.created_at)
  };
}

async function initDb() {
  await runAsync(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admission_no TEXT,
    name TEXT NOT NULL,
    class TEXT,
    guardian TEXT,
    balance REAL DEFAULT 0
  );`);
  await runAsync(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    amount REAL,
    method TEXT,
    note TEXT,
    payer_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(id)
  );`);
  await runAsync(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'user'
  );`);

  const row = await getAsync('SELECT COUNT(*) AS c FROM students');
  if (row && row.c === 0) {
    const students = [
      ['ADM001','John Doe','Form 1','Mr. Doe', 120.00],
      ['ADM002','Mary Mensah','Form 2','Mrs. Mensah', 60.00],
      ['ADM003','Kwame Nkrumah','Form 3','Mr. Nkrumah', 0],
      ['ADM004','Ama Serwaa','Form 1','Mrs. Serwaa', 30.5],
      ['ADM005','Joseph Agyei','Form 2','Mr. Agyei', 250.0],
      ['ADM006','Rita Ofori','Form 3','Mrs. Ofori', 10.0]
    ];
    const stmt = db.prepare('INSERT INTO students (admission_no,name,class,guardian,balance) VALUES (?,?,?,?,?)');
    for (const s of students) stmt.run(s);
    stmt.finalize();
  }

  const urow = await getAsync('SELECT COUNT(*) AS c FROM users');
  if (urow && urow.c === 0) {
    const pwHash = bcrypt.hashSync('password', 10);
    await runAsync('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', ['Admin','admin@samaced.test', pwHash, 'admin']);
    await runAsync('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', ['Clerk','clerk@samaced.test', bcrypt.hashSync('password',10), 'clerk']);
  }
}
initDb();

// Middleware
function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization;
  if (!hdr || !hdr.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  try {
    const token = hdr.slice(7);
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes
app.get('/api/students', async (req, res) => {
  const q = (req.query.query || req.query.q || "").trim();
  let rows;
  if (!q) {
    rows = await allAsync('SELECT * FROM students ORDER BY name LIMIT 30');
  } else {
    const like = `%${q.replace(/%/g,'')}%`;
    rows = await allAsync('SELECT * FROM students WHERE name LIKE ? OR admission_no LIKE ? ORDER BY name LIMIT 30',[like,like]);
  }
  res.json(rows.map(addStudentFields));
});
app.get('/api/typeahead', (req, res) => {
  req.url = '/api/students' + (req.url.indexOf('?')>-1 ? req.url.slice(req.url.indexOf('?')) : '');
  app._router.handle(req, res);
});
app.get('/api/students/:id', async (req,res)=>{
  const s = await getAsync('SELECT * FROM students WHERE id=?',[req.params.id]);
  if(!s) return res.status(404).json({error:'Not found'});
  res.json(addStudentFields(s));
});
app.post('/api/payments', async (req,res)=>{
  const { studentId, amount, method, note, payer_name } = req.body;
  if (!studentId || !amount) return res.status(400).json({ error: 'studentId and amount required' });
  await runAsync('INSERT INTO payments (student_id,amount,method,note,payer_name) VALUES (?,?,?,?,?)',[studentId,amount,method||'cash',note||'',payer_name||'']);
  await runAsync('UPDATE students SET balance = balance - ? WHERE id=?',[amount,studentId]);
  const student = await getAsync('SELECT * FROM students WHERE id=?',[studentId]);
  res.json({ success:true, student:addStudentFields(student) });
});
app.get('/api/payments', async (req,res)=>{
  let rows;
  if (req.query.studentId) rows = await allAsync('SELECT * FROM payments WHERE student_id=? ORDER BY created_at DESC',[req.query.studentId]);
  else rows = await allAsync('SELECT * FROM payments ORDER BY created_at DESC LIMIT 200');
  res.json(rows.map(addPaymentFields));
});
app.post('/api/login', async (req,res)=>{
  const {email,password} = req.body;
  const u = await getAsync('SELECT * FROM users WHERE email=?',[email]);
  if(!u) return res.status(401).json({error:'invalid credentials'});
  if(!bcrypt.compareSync(password,u.password_hash)) return res.status(401).json({error:'invalid credentials'});
  const token = jwt.sign({id:u.id,email:u.email,role:u.role,name:u.name},JWT_SECRET,{expiresIn:'8h'});
  res.json({token,user:{id:u.id,email:u.email,role:u.role,name:u.name}});
});
app.get('/api/me', authMiddleware, (req,res)=>res.json(req.user));

// Serve frontend if needed
app.use('/', express.static(path.join(__dirname,'public')));

app.listen(PORT, ()=>console.log(`Samaced backend running at http://localhost:${PORT}`));
