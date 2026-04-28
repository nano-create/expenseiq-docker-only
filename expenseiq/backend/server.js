/**
 * ExpenseIQ — Smart Expense Tracker
 * Complete Backend API v2.0
 *
 * FEATURES:
 *   - User Authentication (register, login, profile update)
 *   - Transactions (add, get, update, delete)
 *   - Budget Management (set monthly budgets per category)
 *   - Savings Goals (create goals, track progress)
 *   - Monthly Reports (month-by-month spending analysis)
 *   - Dashboard Summary (balance, charts, recent activity)
 *   - Budget Alerts (warns when spending exceeds 80% of budget)
 *   - Recurring Transactions (auto-add monthly bills)
 */

const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const mongoose  = require('mongoose');
const cron      = require('node-cron');

const app = express();

// ─────────────────────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'expenseiq_secret_key_2024';
const MONGO_URL  = process.env.MONGO_URL  || 'mongodb://localhost:27017/expenseiq';

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  DATABASE CONNECTION
// ─────────────────────────────────────────────────────────────
mongoose.connect(MONGO_URL)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ─────────────────────────────────────────────────────────────
//  SCHEMAS & MODELS
// ─────────────────────────────────────────────────────────────

// USER
const userSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password:      { type: String, required: true, select: false },
  currency:      { type: String, default: '₹' },
  monthlyIncome: { type: Number, default: 0 },
  avatar:        { type: String, default: '' },
  createdAt:     { type: Date,   default: Date.now }
});
const User = mongoose.model('User', userSchema);

// TRANSACTION
const txnSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, enum: ['income', 'expense'], required: true },
  amount:      { type: Number, required: true, min: 0.01 },
  category:    { type: String, required: true },
  description: { type: String, required: true, trim: true },
  date:        { type: Date, default: Date.now },
  isRecurring: { type: Boolean, default: false },
  recurringId: { type: String, default: null },
  tags:        [String],
  note:        { type: String, default: '' }
}, { timestamps: true });
const Transaction = mongoose.model('Transaction', txnSchema);

// BUDGET (monthly limit per category)
const budgetSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String, required: true },
  limit:    { type: Number, required: true, min: 1 },
  month:    { type: String, required: true }, // "2024-04"
  spent:    { type: Number, default: 0 }
}, { timestamps: true });
budgetSchema.index({ user: 1, category: 1, month: 1 }, { unique: true });
const Budget = mongoose.model('Budget', budgetSchema);

// SAVINGS GOAL
const goalSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:       { type: String, required: true, trim: true },
  targetAmount:{ type: Number, required: true, min: 1 },
  savedAmount: { type: Number, default: 0 },
  deadline:    { type: Date },
  icon:        { type: String, default: '🎯' },
  color:       { type: String, default: '#4c8dff' },
  status:      { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' }
}, { timestamps: true });
const Goal = mongoose.model('Goal', goalSchema);

// RECURRING TRANSACTION TEMPLATE
const recurringSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['income', 'expense'], required: true },
  amount:      { type: Number, required: true },
  category:    { type: String, required: true },
  description: { type: String, required: true },
  frequency:   { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'monthly' },
  dayOfMonth:  { type: Number, default: 1 },
  isActive:    { type: Boolean, default: true },
  lastRun:     { type: Date }
}, { timestamps: true });
const Recurring = mongoose.model('Recurring', recurringSchema);

// ─────────────────────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h?.startsWith('Bearer '))
    return res.status(401).json({ message: 'Please log in first.' });
  try {
    req.user = jwt.verify(h.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
}

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
const currentMonth = () => new Date().toISOString().slice(0, 7); // "2024-04"
const monthRange   = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return {
    start: new Date(y, m - 1, 1),
    end:   new Date(y, m, 0, 23, 59, 59)
  };
};

// ─────────────────────────────────────────────────────────────
//  ROUTES — HEALTH
// ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:   'running',
    app:      'ExpenseIQ v2.0',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    time:     new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — AUTH
// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, monthlyIncome } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: 'Name, email and password are required.' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });

    if (await User.findOne({ email }))
      return res.status(400).json({ message: 'This email is already registered.' });

    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hash, monthlyIncome: monthlyIncome || 0 });

    res.status(201).json({ message: `Welcome to ExpenseIQ, ${name}! Please log in.` });
  } catch (e) {
    console.error('Register:', e.message);
    res.status(500).json({ message: 'Server error.' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email and password are required.' });

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Invalid email or password.' });

    const token = jwt.sign(
      { id: user._id, name: user.name, email: user.email, currency: user.currency },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: { id: user._id, name: user.name, email: user.email,
              currency: user.currency, monthlyIncome: user.monthlyIncome }
    });
  } catch (e) {
    console.error('Login:', e.message);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  res.json({ user });
});

// PUT /api/auth/profile  — update name, monthly income, currency
app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { name, monthlyIncome, currency } = req.body;
    const updates = {};
    if (name)          updates.name          = name;
    if (monthlyIncome) updates.monthlyIncome = monthlyIncome;
    if (currency)      updates.currency      = currency;

    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true });
    res.json({ message: 'Profile updated.', user });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — TRANSACTIONS
// ─────────────────────────────────────────────────────────────
// POST /api/transactions
app.post('/api/transactions', auth, async (req, res) => {
  try {
    const { type, amount, category, description, date, tags, note } = req.body;
    if (!type || !amount || !category || !description)
      return res.status(400).json({ message: 'type, amount, category, description are required.' });
    if (!['income','expense'].includes(type))
      return res.status(400).json({ message: 'type must be income or expense.' });
    if (parseFloat(amount) <= 0)
      return res.status(400).json({ message: 'Amount must be greater than 0.' });

    const txn = await Transaction.create({
      user: req.user.id, type, amount: parseFloat(amount),
      category, description, tags: tags || [], note: note || '',
      date: date ? new Date(date) : new Date()
    });

    // Update budget spent amount if it's an expense
    if (type === 'expense') {
      const month = (date ? new Date(date) : new Date()).toISOString().slice(0, 7);
      await Budget.findOneAndUpdate(
        { user: req.user.id, category, month },
        { $inc: { spent: parseFloat(amount) } }
      );
    }

    res.status(201).json({ message: 'Transaction added!', transaction: txn });
  } catch (e) {
    console.error('Add txn:', e.message);
    res.status(500).json({ message: 'Server error.' });
  }
});

// GET /api/transactions  — with optional filters
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const { type, category, month, limit = 100, page = 1 } = req.query;
    const filter = { user: req.user.id };

    if (type)     filter.type     = type;
    if (category) filter.category = category;
    if (month) {
      const { start, end } = monthRange(month);
      filter.date = { $gte: start, $lte: end };
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Transaction.countDocuments(filter);
    const txns  = await Transaction.find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({ transactions: txns, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// PUT /api/transactions/:id  — edit a transaction
app.put('/api/transactions/:id', auth, async (req, res) => {
  try {
    const txn = await Transaction.findOne({ _id: req.params.id, user: req.user.id });
    if (!txn) return res.status(404).json({ message: 'Transaction not found.' });

    const { amount, category, description, date, tags, note } = req.body;

    // Recalculate budget if category/amount changed
    if (txn.type === 'expense') {
      const oldMonth = txn.date.toISOString().slice(0, 7);
      await Budget.findOneAndUpdate(
        { user: req.user.id, category: txn.category, month: oldMonth },
        { $inc: { spent: -txn.amount } }
      );
    }

    if (amount)      txn.amount      = parseFloat(amount);
    if (category)    txn.category    = category;
    if (description) txn.description = description;
    if (date)        txn.date        = new Date(date);
    if (tags)        txn.tags        = tags;
    if (note !== undefined) txn.note = note;

    await txn.save();

    if (txn.type === 'expense') {
      const newMonth = txn.date.toISOString().slice(0, 7);
      await Budget.findOneAndUpdate(
        { user: req.user.id, category: txn.category, month: newMonth },
        { $inc: { spent: txn.amount } }
      );
    }

    res.json({ message: 'Transaction updated.', transaction: txn });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/transactions/:id
app.delete('/api/transactions/:id', auth, async (req, res) => {
  try {
    const txn = await Transaction.findOne({ _id: req.params.id, user: req.user.id });
    if (!txn) return res.status(404).json({ message: 'Transaction not found.' });

    // Subtract from budget
    if (txn.type === 'expense') {
      const month = txn.date.toISOString().slice(0, 7);
      await Budget.findOneAndUpdate(
        { user: req.user.id, category: txn.category, month },
        { $inc: { spent: -txn.amount } }
      );
    }

    await txn.deleteOne();
    res.json({ message: 'Transaction deleted.' });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — DASHBOARD SUMMARY
// ─────────────────────────────────────────────────────────────
// GET /api/summary
app.get('/api/summary', auth, async (req, res) => {
  try {
    const uid   = req.user.id;
    const month = req.query.month || currentMonth();
    const { start, end } = monthRange(month);

    // All-time totals
    const all = await Transaction.find({ user: uid });
    let totalIncome = 0, totalExpense = 0;
    all.forEach(t => t.type === 'income' ? totalIncome += t.amount : totalExpense += t.amount);

    // This month
    const monthTxns = all.filter(t => t.date >= start && t.date <= end);
    let mIncome = 0, mExpense = 0;
    const catMap = {};
    monthTxns.forEach(t => {
      if (t.type === 'income') { mIncome += t.amount; }
      else { mExpense += t.amount; catMap[t.category] = (catMap[t.category]||0) + t.amount; }
    });

    // Last 6 months trend
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(); d.setMonth(d.getMonth() - i);
      const ym  = d.toISOString().slice(0, 7);
      const { start: s, end: e } = monthRange(ym);
      const mt  = all.filter(t => t.date >= s && t.date <= e);
      let inc = 0, exp = 0;
      mt.forEach(t => t.type === 'income' ? inc += t.amount : exp += t.amount);
      trend.push({ month: ym, income: inc, expense: exp, balance: inc - exp });
    }

    // Category breakdown (sorted)
    const categoryBreakdown = Object.entries(catMap)
      .map(([c, a]) => ({ category: c, amount: a }))
      .sort((a, b) => b.amount - a.amount);

    // Savings rate
    const savingsRate = mIncome > 0
      ? parseFloat(((mIncome - mExpense) / mIncome * 100).toFixed(1))
      : 0;

    // Budget alerts
    const budgets = await Budget.find({ user: uid, month });
    const alerts  = budgets
      .filter(b => b.spent >= b.limit * 0.8)
      .map(b => ({
        category:  b.category,
        limit:     b.limit,
        spent:     b.spent,
        pct:       Math.round(b.spent / b.limit * 100),
        exceeded:  b.spent >= b.limit
      }));

    // Savings goals progress
    const goals = await Goal.find({ user: uid, status: 'active' });

    res.json({
      allTime:   { totalIncome, totalExpense, balance: totalIncome - totalExpense },
      thisMonth: { income: mIncome, expense: mExpense, balance: mIncome - mExpense, savingsRate },
      categoryBreakdown,
      trend,
      recentTransactions: all.sort((a,b) => b.date - a.date).slice(0, 8),
      budgetAlerts: alerts,
      goals: goals.map(g => ({
        ...g.toObject(),
        progress: Math.min(100, Math.round(g.savedAmount / g.targetAmount * 100))
      })),
      totalTransactions: all.length
    });
  } catch (e) {
    console.error('Summary:', e.message);
    res.status(500).json({ message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — MONTHLY REPORT
// ─────────────────────────────────────────────────────────────
// GET /api/report/:month   e.g. /api/report/2024-04
app.get('/api/report/:month', auth, async (req, res) => {
  try {
    const uid  = req.user.id;
    const { month } = req.params;
    const { start, end } = monthRange(month);

    const txns = await Transaction.find({ user: uid, date: { $gte: start, $lte: end } }).sort({ date: 1 });

    let income = 0, expense = 0;
    const incCat = {}, expCat = {};
    const daily  = {};

    txns.forEach(t => {
      const d = t.date.toISOString().slice(0, 10);
      if (!daily[d]) daily[d] = { income: 0, expense: 0 };

      if (t.type === 'income') {
        income += t.amount;
        incCat[t.category] = (incCat[t.category] || 0) + t.amount;
        daily[d].income += t.amount;
      } else {
        expense += t.amount;
        expCat[t.category] = (expCat[t.category] || 0) + t.amount;
        daily[d].expense += t.amount;
      }
    });

    const budgets = await Budget.find({ user: uid, month });

    res.json({
      month,
      summary: { income, expense, balance: income - expense, transactions: txns.length },
      incomeByCategory:  Object.entries(incCat).map(([c,a]) => ({ category:c, amount:a })).sort((a,b)=>b.amount-a.amount),
      expenseByCategory: Object.entries(expCat).map(([c,a]) => ({ category:c, amount:a })).sort((a,b)=>b.amount-a.amount),
      dailyData: Object.entries(daily).map(([date, v]) => ({ date, ...v })).sort((a,b)=>a.date.localeCompare(b.date)),
      budgets: budgets.map(b => ({ ...b.toObject(), pct: b.limit>0 ? Math.round(b.spent/b.limit*100) : 0 })),
      transactions: txns
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — BUDGETS
// ─────────────────────────────────────────────────────────────
// GET /api/budgets?month=2024-04
app.get('/api/budgets', auth, async (req, res) => {
  const month = req.query.month || currentMonth();
  const budgets = await Budget.find({ user: req.user.id, month });
  res.json({ budgets, month });
});

// POST /api/budgets  — set or update a budget
app.post('/api/budgets', auth, async (req, res) => {
  try {
    const { category, limit, month } = req.body;
    if (!category || !limit)
      return res.status(400).json({ message: 'category and limit are required.' });

    const m = month || currentMonth();

    // Calculate already-spent for this month/category
    const { start, end } = monthRange(m);
    const spent = await Transaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(req.user.id), type:'expense', category, date:{ $gte:start, $lte:end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const spentAmount = spent[0]?.total || 0;

    const budget = await Budget.findOneAndUpdate(
      { user: req.user.id, category, month: m },
      { limit: parseFloat(limit), spent: spentAmount },
      { upsert: true, new: true }
    );

    res.json({ message: 'Budget saved!', budget });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/budgets/:id
app.delete('/api/budgets/:id', auth, async (req, res) => {
  await Budget.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  res.json({ message: 'Budget removed.' });
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — SAVINGS GOALS
// ─────────────────────────────────────────────────────────────
// GET /api/goals
app.get('/api/goals', auth, async (req, res) => {
  const goals = await Goal.find({ user: req.user.id }).sort({ createdAt: -1 });
  res.json({ goals: goals.map(g => ({
    ...g.toObject(),
    progress: Math.min(100, Math.round(g.savedAmount / g.targetAmount * 100)),
    remaining: Math.max(0, g.targetAmount - g.savedAmount)
  }))});
});

// POST /api/goals
app.post('/api/goals', auth, async (req, res) => {
  try {
    const { title, targetAmount, deadline, icon, color } = req.body;
    if (!title || !targetAmount)
      return res.status(400).json({ message: 'title and targetAmount are required.' });

    const goal = await Goal.create({
      user: req.user.id, title, targetAmount: parseFloat(targetAmount),
      deadline: deadline ? new Date(deadline) : undefined,
      icon: icon || '🎯', color: color || '#4c8dff'
    });
    res.status(201).json({ message: 'Goal created!', goal });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// PUT /api/goals/:id/contribute  — add money to a goal
app.put('/api/goals/:id/contribute', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || parseFloat(amount) <= 0)
      return res.status(400).json({ message: 'Valid amount required.' });

    const goal = await Goal.findOne({ _id: req.params.id, user: req.user.id });
    if (!goal) return res.status(404).json({ message: 'Goal not found.' });

    goal.savedAmount += parseFloat(amount);
    if (goal.savedAmount >= goal.targetAmount) {
      goal.status = 'completed';
      goal.savedAmount = goal.targetAmount;
    }
    await goal.save();

    res.json({
      message: goal.status === 'completed' ? '🎉 Goal completed!' : 'Contribution added!',
      goal,
      progress: Math.round(goal.savedAmount / goal.targetAmount * 100)
    });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/goals/:id
app.delete('/api/goals/:id', auth, async (req, res) => {
  await Goal.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  res.json({ message: 'Goal deleted.' });
});

// ─────────────────────────────────────────────────────────────
//  ROUTES — RECURRING TRANSACTIONS
// ─────────────────────────────────────────────────────────────
// GET /api/recurring
app.get('/api/recurring', auth, async (req, res) => {
  const list = await Recurring.find({ user: req.user.id }).sort({ createdAt: -1 });
  res.json({ recurring: list });
});

// POST /api/recurring
app.post('/api/recurring', auth, async (req, res) => {
  try {
    const { type, amount, category, description, frequency, dayOfMonth } = req.body;
    if (!type || !amount || !category || !description)
      return res.status(400).json({ message: 'All fields required.' });

    const rec = await Recurring.create({
      user: req.user.id, type, amount: parseFloat(amount),
      category, description,
      frequency: frequency || 'monthly',
      dayOfMonth: dayOfMonth || 1
    });
    res.status(201).json({ message: 'Recurring transaction set!', recurring: rec });
  } catch (e) {
    res.status(500).json({ message: 'Server error.' });
  }
});

// DELETE /api/recurring/:id
app.delete('/api/recurring/:id', auth, async (req, res) => {
  await Recurring.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  res.json({ message: 'Recurring transaction removed.' });
});

// ─────────────────────────────────────────────────────────────
//  CRON — Process recurring transactions every day at midnight
// ─────────────────────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    console.log('⏰ Running recurring transactions cron...');
    const today = new Date();
    const dom   = today.getDate();
    const recs  = await Recurring.find({ isActive: true, dayOfMonth: dom });

    for (const r of recs) {
      await Transaction.create({
        user: r.user, type: r.type, amount: r.amount,
        category: r.category, description: `[Auto] ${r.description}`,
        isRecurring: true, recurringId: r._id.toString(), date: today
      });
      r.lastRun = today;
      await r.save();
    }
    console.log(`✅ Processed ${recs.length} recurring transactions`);
  } catch (e) {
    console.error('Cron error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 ExpenseIQ API v2.0 running at http://localhost:${PORT}`);
  console.log(`   MongoDB  : ${MONGO_URL}`);
  console.log(`   Health   : http://localhost:${PORT}/api/health\n`);
});
