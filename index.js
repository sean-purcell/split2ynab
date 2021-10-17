/* eslint-disable no-unused-vars */
const { timeout } = require('promise-timeout');
const Splitwise = require('splitwise');
const ynabApi = require('ynab');
const sqlite = require('sqlite-async');
const nconf = require('nconf');
const printf = require('printf');

nconf.argv().env({
  separator: '__',
  lowerCase: true,
  parseValues: true,
});

const txnSplitwiseToYnab = (account_id, split_uid, txn) => {
  const user = txn.users.find((user) => user.user_id == split_uid);
  if (!user) {
    return null;
  }

  const owing = Math.round(Number(user.net_balance) * 1000);

  const result = {
    date: txn.date,
    amount: owing,
    cleared: 'uncleared',
    approved: false,
    account_id,
    import_id: `split2ynab.v2:${txn.id}`,
    memo: txn.description,
  };
  const { first_name, last_name, id } = txn.created_by;
  if (id != split_uid) {
    result.payee = `${first_name} ${last_name}`;
  }

  return result;
};

const getDb = async () => {
  console.log('opening database');
  const db = await sqlite.open(nconf.get('db'));
  console.log('creating table');
  await db.run(`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT NOT NULL PRIMARY KEY,
    updated DATETIME NOT NULL
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS expenses_updated ON expenses (updated)');
  console.log('created table');
  return db;
};

const getYnabAccount = async (ynab) => {
  const { budgetName, accountName } = (() => {
    const { key, budget, account } = nconf.get('ynab');
    return { budgetName: budget, accountName: account };
  })();
  const { budgets } = (await ynab.budgets.getBudgets()).data;
  const budget = budgets.find((budget) => budget.name == budgetName || budget.id == budgetName);
  if (budget == undefined) {
    throw new Error(`budget ${budgetName} not found`);
  }
  console.log('budget:\n%o', budget);
  const { accounts } = (await ynab.accounts.getAccounts(budget.id)).data;
  const account = accounts.find((account) => account.name == accountName || account.id == accountName);
  if (account == undefined) {
    throw new Error(`account ${accountName} not found`);
  }
  console.log('account:\n%o', account);
  return { budget: budget.id, account: account.id };
};

const importTransactions = async () => {
  const ynabApiKey = nconf.get('ynab_api_key');
  const splitwiseApiKey = nconf.get('splitwise_api_key');

  const startDate = nconf.get('start_date');

  console.log(`split api key: ${splitwiseApiKey}`);
  console.log(`ynab api key: ${ynabApiKey}`);

  const sw = Splitwise({
    logger: console.log, apiKey: splitwiseApiKey,
  });

  const ynab = new ynabApi.API(ynabApiKey);

  const swUser = await sw.getCurrentUser();
  console.log('splitwise user: %o', swUser);

  const db = await getDb();

  const latest_update = await (async () => {
    const result = await db.get('SELECT updated FROM expenses ORDER BY updated DESC LIMIT 1');
    console.log(`newest write: ${result}`);
    if (result) {
      return result.updated;
    }
    return undefined;
  })();

  console.log(`latest update: ${latest_update}`);

  const debug = nconf.get('debug');
  const query = (() => {
    if (latest_update) {
      return {
        dated_after: startDate,
        updated_after: latest_update,
        limit: 0,
      };
    }

    return {
      dated_after: startDate,
      limit: 0,
    };
  })();
  console.log('query:\n%o', query);
  const expenses = await timeout(sw.getExpenses(query), 5000);

  const txns = expenses.filter((t) => !latest_update || t.updated_at > latest_update);

  if (debug) {
    console.log('txns:\n%o', txns);
  }

  const { budget, account } = await getYnabAccount(ynab);
  console.log('budget: %o, account: %o', budget, account);

  let ynabTxns = txns.map(
    (txn) => ({ updated_at: txn.updated_at, ynab: txnSplitwiseToYnab(account, swUser.id, txn) }),
  ).filter((x) => x.ynab).sort((a, b) => {
    if (a.updated_at < b.updated_at) {
      return -1;
    } if (a.updated_at < b.updated_at) {
      return 1;
    }
    return 0;
  });

  const existingIds = await (async () => {
    const rows = await db.all('SELECT id FROM expenses');
    return new Set(rows.map((row) => row.id));
  })();

  const limit = nconf.get('limit');
  if (limit !== undefined) {
    ynabTxns = ynabTxns.slice(0, limit);
  }

  if (debug) {
    console.log('ynab txns:\n%o', ynabTxns);
  }

  transactionsToSend = ynabTxns.map((t) => t.ynab);

  if (transactionsToSend.length && !nconf.get('nowrite')) {
    const updates = transactionsToSend.filter((x) => existingIds.has(x.import_id));
    const creates = transactionsToSend.filter((x) => !existingIds.has(x.import_id));

    console.log('updates:\n%o', updates);

    if (updates.length) {
      await ynab.transactions.updateTransactions(budget,
        { transactions: updates });
    }

    console.log('creates:\n%o', creates);
    if (creates.length) {
      await ynab.transactions.createTransactions(budget,
        { transactions: creates });
    }

    for (const { ynab, updated_at } of ynabTxns) {
      await db.run(`INSERT INTO expenses
        VALUES(?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated=excluded.updated`, [ynab.import_id, updated_at]);
      console.log(`inserted: ${ynab.import_id}, ${updated_at}`);
    }
  } else {
    console.log('nothing to send');
  }
  await db.close();
};

const budgetIntoCreditCards = async () => {
  const ynabApiKey = nconf.get('ynab_api_key');
  const ynab = new ynabApi.API(ynabApiKey);

  const { budget, account } = await getYnabAccount(ynab);

  const now = new Date();
  const iso_month = printf('%04d-%02d-01', now.getFullYear(), now.getMonth() + 1);

  const { accounts } = (await ynab.accounts.getAccounts(budget)).data;
  const { category_groups } = (await ynab.categories.getCategories(budget)).data;

  const creditCardCategories = category_groups
    .find((c) => c.name == 'Credit Card Payments')
    .categories;
  for (const category of creditCardCategories) {
    const account = accounts.find((a) => a.name == category.name);
    const needed_balance = -account.balance;
    const budgeted_balance = category.balance;
    const diff = needed_balance - budgeted_balance;
    const new_budgeted = category.budgeted + diff;
    console.log(`Credit card: ${category.name}, needed: ${needed_balance}, available: ${budgeted_balance}, new budgeted: ${new_budgeted}`);
    if (diff != 0) {
      const result = await ynab.categories.updateMonthCategory(budget, iso_month, category.id,
        { category: { budgeted: new_budgeted } });
      console.log(`Updated ${category.name} to ${new_budgeted} for ${iso_month}, result: %o`, result);
    } else {
      console.log(`No action necessary for ${category.name}`);
    }
  }
};

const main = async () => {
  await importTransactions();
  if (nconf.get('budget_ccs')) {
    await budgetIntoCreditCards();
  }
};

(async () => {
  if (nconf.get('loop') && nconf.get('delay')) {
    while (true) {
      try {
        await main();
      } catch (error) {
        console.log('failed: %o', error);
      }
      await new Promise((r) => setTimeout(r, nconf.get('delay')));
    }
  } else {
    await main();
  }
})().then(() => process.exit(0)).catch((e) => {
  console.log('Error: %o', e);
  process.exit(1);
});
