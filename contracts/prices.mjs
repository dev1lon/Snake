#!/usr/bin/env node
// Turns the dollar prices into the wei the contract actually wants.
//
//   node contracts/prices.mjs             # fetches the ETH price
//   node contracts/prices.mjs 2458        # or takes your own rate
//   node contracts/prices.mjs 2458 1 10 0.1 20
//
// Prints the four constructor arguments in order, ready to paste into a deploy
// or into setPrices(). Re-run it whenever ETH has moved far enough to matter —
// that is the whole reason the prices are variables and not constants.

const [rateArg, singleArg, packArg, recordArg, packSizeArg] = process.argv.slice(2);

const SINGLE_USD = Number(singleArg ?? 1);
const PACK_USD = Number(packArg ?? 10);
const RECORD_USD = Number(recordArg ?? 0.1);
const PACK_REVIVES = Number(packSizeArg ?? 20);

async function fetchEthUsd() {
  const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");

  if (!response.ok) {
    throw new Error(`Coinbase answered ${response.status}`);
  }

  const body = await response.json();
  const price = Number(body?.data?.amount);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Unexpected price payload");
  }

  return price;
}

// Rounds to one significant figure of ETH, which is what makes a price legible
// in a wallet ("0.0004 ETH", not "0.000406834825061025 ETH"). The dollar figure
// it lands on is printed too, so the drift is never a surprise.
function toWei(usd, ethUsd) {
  const eth = usd / ethUsd;
  const magnitude = 10 ** Math.floor(Math.log10(eth));
  const rounded = Math.round(eth / magnitude) * magnitude;

  return {
    eth: rounded,
    usd: rounded * ethUsd,
    wei: BigInt(Math.round(rounded * 1e18))
  };
}

const ethUsd = Number(rateArg) > 0 ? Number(rateArg) : await fetchEthUsd();

const single = toWei(SINGLE_USD, ethUsd);
const pack = toWei(PACK_USD, ethUsd);
const record = toWei(RECORD_USD, ethUsd);

const rows = [
  ["singleRevivePrice", SINGLE_USD, single],
  ["packRevivePrice", PACK_USD, pack],
  ["recordPrice", RECORD_USD, record]
];

console.log(`ETH/USD ${ethUsd.toFixed(2)}\n`);

for (const [name, target, value] of rows) {
  console.log(
    `${name.padEnd(18)} target $${String(target).padEnd(5)} → ${value.eth} ETH ` +
      `($${value.usd.toFixed(3)})  ${value.wei}`
  );
}

console.log(`\npackRevives        ${PACK_REVIVES}`);
console.log(`\nconstructor(${single.wei}, ${pack.wei}, ${PACK_REVIVES}, ${record.wei})`);
