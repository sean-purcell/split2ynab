/* eslint-disable no-unused-vars */
const sw = require('splitwise');
const ynab = require('ynab');
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

async function main() {
  const zooconf = nconf.get('zoo');
  console.log('zookeeper config: %o', zooconf);

  const zoo = await zookeeperClient(zooconf);

  await ensureExists(zoo, LATEST_UPDATE);
  const latest_update = await getValue(zoo, LATEST_UPDATE);

  console.log(`latest update: ${latest_update}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.log(`Error: ${e}`);
  process.exit(1);
});
