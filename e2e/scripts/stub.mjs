// A stand-in for DefiLlama, Frankfurter and CoinGecko, answering from recorded fixtures, so
// end-to-end runs need no network and always see the same prices.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)))
const prices = fixture('defillama-prices')
const percentage = fixture('defillama-percentage')
const rates = fixture('frankfurter-latest')
const search = fixture('coingecko-search')

/** Answers only the ids asked for, like the real API. */
function pick(all, path, prefix) {
  const ids = decodeURIComponent(path.slice(prefix.length)).split(',')
  return {
    coins: Object.fromEntries(ids.filter((id) => id in all.coins).map((id) => [id, all.coins[id]])),
  }
}

export function startStub(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    let body
    if (url.pathname.startsWith('/prices/current/'))
      body = pick(prices, url.pathname, '/prices/current/')
    else if (url.pathname.startsWith('/percentage/'))
      body = pick(percentage, url.pathname, '/percentage/')
    else if (url.pathname === '/v1/latest') body = rates
    else if (url.pathname === '/api/v3/search') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase()
      body = {
        coins: search.coins.filter((coin) =>
          `${coin.id} ${coin.name} ${coin.symbol}`.toLowerCase().includes(q),
        ),
      }
    }
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'not stubbed' }))
  })
  server.listen(port)
  return server
}
