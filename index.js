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

  const expenses = await sw.getExpenses({
    dated_after: startDate,
    limit: 0,
  });
  console.log('expenses:\n%o', expenses);

  const { budget, account } = await getYnabAccount(ynab);
};

main().then(() => process.exit(0)).catch((e) => {
  console.log(`Error: ${e}`);
  process.exit(1);
});
