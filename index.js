/* eslint-disable no-unused-vars */
const Splitwise = require('splitwise');
const ynabApi = require('ynab');
const zookeeper = require('node-zookeeper-client');
const nconf = require('nconf');

const LATEST_UPDATE = '/latest_update';

nconf.argv().env({
  separator: '__',
  lowerCase: true,
  parseValues: true,
});

async function zookeeperClient(zooconf) {
  const client = zookeeper.createClient(zooconf.connect);

  const zoo = await new Promise((resolve, reject) => {
    client.once('connected', () => {
      console.log('connected to Zookeeper');
      resolve(client);
    });

    client.connect();
  });

  return zoo;
}

async function ensureExists(zoo, path) {
  return new Promise((resolve, reject) => {
    zoo.create(path, (error) => {
      if (error) {
        if (error.getCode() == zookeeper.Exception.NODE_EXISTS) {
          resolve();
        } else { reject(error); }
      } else { resolve(); }
    });
  });
}

async function getValue(zoo, path) {
  return new Promise((resolve, reject) => {
    zoo.getData(path, (error, data) => {
      if (error) { reject(error); } else { resolve(data); }
    });
  });
}

async function setValue(zoo, path, data) {
  return new Promise((resolve, reject) => {
    zoo.setData(path, data, (error) => {
      if (error) { reject(error); } else { resolve(); }
    });
  });
}

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
    import_id: `split2ynab:${txn.id}`,
    memo: txn.description,
  };
  const { first_name, last_name, id } = txn.created_by;
  if (id != split_uid) {
    result.payee = `${first_name} ${last_name}`;
  }

  return result;
};

const getYnabAccount = async (ynab) => {
  const { budgetName, accountName } = (() => {
    const { budget, account } = nconf.get('ynab');
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

const main = async () => {
  const zooconf = nconf.get('zoo');
  console.log('zookeeper config: %o', zooconf);

  const zoo = await zookeeperClient(zooconf);

  await ensureExists(zoo, LATEST_UPDATE);
  const latest_update = await getValue(zoo, LATEST_UPDATE);

  const startDate = await (async () => {
    const startDate = nconf.get('start_date');
    if (startDate) {
      return startDate;
    }

    return await getValue(zoo, '/start_date');
  })();
  const splitwiseApiKey = await getValue(zoo, '/splitwise/api_key');
  const ynabApiKey = await getValue(zoo, '/ynab/api_key');

  console.log(`split api key: ${splitwiseApiKey}`);
  console.log(`ynab api key: ${ynabApiKey}`);

  console.log(`latest update: ${latest_update}`);

  const sw = Splitwise({
    logger: console.log, apiKey: splitwiseApiKey,
  });

  const ynab = new ynabApi.API(ynabApiKey);

  const swUser = await sw.getCurrentUser();
  console.log('splitwise user: %o', swUser);

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
  const txns = (await sw.getExpenses(query)).filter((t) => t.updated_at > latest_update);
  console.log('txns:\n%o', txns);

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

  const existingTransactions = (await ynab.transactions.getTransactionsByAccount(budget, account)).data.transactions;
  const existingImportIds = new Set(
    existingTransactions.map((t) => t.import_id),
  );

  console.log('example transactions:\n%o', existingTransactions);

  console.log('unlimited ynab txns:\n%o', ynabTxns);

  const limit = nconf.get('limit');
  if (limit !== undefined) {
    ynabTxns = ynabTxns.slice(0, limit);
  }

  console.log('ynab txns:\n%o', ynabTxns);

  transactionsToSend = ynabTxns.map((t) => t.ynab);

  if (transactionsToSend.length && !nconf.get('nowrite')) {
    const updates = transactionsToSend.filter((x) => existingImportIds.has(x.import_id));
    const creates = transactionsToSend.filter((x) => !existingImportIds.has(x.import_id));

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

    const max_updated_at = ynabTxns.map((t) => t.updated_at)
      .reduce((acc, val) => {
        if (acc > val) {
          return acc;
        }
        return val;
      });
    console.log(`max updated at: ${max_updated_at}`);

    if (nconf.get('writeback')) {
      await setValue(zoo, LATEST_UPDATE, Buffer.from(max_updated_at));
    }
  } else {
    console.log('nothing to send');
  }
};

main().then(() => process.exit(0)).catch((e) => {
  console.log('Error: %o', e);
  process.exit(1);
});
