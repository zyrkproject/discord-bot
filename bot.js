const Discord = require("discord.js");
const { XMLHttpRequest } = require("xmlhttprequest");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const config_json_file = path.dirname(process.argv[1]) + "/config.json";
const users_addr_folder = path.dirname(process.argv[1]) + "/.db_users_addr";
const users_mn_folder = path.dirname(process.argv[1]) + "/.db_users_mn";

/** @typedef {Object} Configuration
  * @property {string[]} special_ticker -
  * @property {Array<string|string[]>} ticker -
  * @property {{prices:number, coininfo:number, explorer:number, other:number, error:number}} color -
  * @property {string[]} devs -
  * @property {{block:number, coll?: number, mn?:number, pos?:number, pow?:number}[]} stages -
  * @property {{blockcount:string, mncount:string, supply:string, balance:string, blockindex:string, blockhash:string, mnstat:string, addnodes:string}} requests -
  * @property {string[]} startorder -
  * @property {{enabled:true, channel:string, interval:number}} monitor -
  * @property {boolean} hidenotsupported -
  * @property {boolean} useraddrs -
  * @property {boolean} usermns -
  * @property {string[]} channel -
  * @property {string} prefix -
  * @property {string} coin -
  * @property {number} blocktime -
  * @property {string} token -
*/
/** @type {Configuration} */
const conf = require(config_json_file);
const client = new Discord.Client();

class ExchangeData {
    constructor(name) {
        this.name = name;
        this.link = "";
        this.price = "Error";
        this.volume = "Error";
        this.buy = "Error";
        this.sell = "Error";
        this.change = "Error";
    }
    fillj(json, price, volume, buy, sell, change) {
        this.fill(json[price], json[volume], json[buy], json[sell], json[change]);
    }
    fill(price, volume, buy, sell, change) {
        if (price === undefined && volume === undefined && buy === undefined && sell === undefined && change === undefined)
            return;
        this.price  = isNaN(price)  ? undefined : parseFloat(price).toFixed(8);
        this.volume = isNaN(volume) ? undefined : parseFloat(volume).toFixed(8);
        this.buy    = isNaN(buy)    ? undefined : parseFloat(buy).toFixed(8);
        this.sell   = isNaN(sell)   ? undefined : parseFloat(sell).toFixed(8);
        this.change = isNaN(change) ? undefined : (change >= 0.0 ? "+" : "") + parseFloat(change).toFixed(2) + "%";
    }
}

function start_monitor() {
    if (conf.monitor !== undefined && conf.monitor.enabled === true) {

        const channel = client.channels.get(conf.monitor.channel);
        let embeds = [];
        let cmd = new BotCommand(undefined, txt => embeds.push(txt));

        const refresh_monitor = async () => {
            embeds = [];
            await cmd.price();
            await cmd.stats();
            await cmd.addnodes();

            await channel.bulkDelete(50);
            for (let emb of embeds)
                await channel.send(emb);
        };

        refresh_monitor().then(() => channel.client.setInterval(() => refresh_monitor(), conf.monitor.interval * 1000)).catch(async e => {
            switch (e.code) {
                case 50001:
                    console.log("\x1b[33mZyrk Bot does not have read messages permission for the monitor channel.\x1b[0m");
                    break;
                case 50013:
                    console.log("\x1b[33mZyrk Bot does not have send or manage messages permission for the monitor channel.\x1b[0m");
                    break;
                case 50034:
                    console.log("\x1b[33mMessages on the monitor channel are over 14 days old, this may take some time to delete them.\x1b[0m");
                    let msgs = await channel.fetchMessages({ limit: 1 });
                    while (msgs.size > 0) {
                        await msgs.last().delete();
                        msgs = await channel.fetchMessages({ limit: 1 });
                    }
                    start_monitor();
                    break;
                default:
                    console.log("Unknown monitoring error:");
                    console.log(e);
                    break;
            }
        });
    }
}
function configure_systemd(name) {
    if (process.platform === "linux") {
        let service = "[Unit]\n" +
            "Description=" + name + " service\n" +
            "After=network.target\n" +
            "\n" +
            "[Service]\n" +
            "User=root\n" +
            "Group=root\n" +
            "ExecStart=" + process.argv[0] + " " + process.argv[1] + "\n" +
            "Restart=always\n" +
            "\n" +
            "[Install]\n" +
            "WantedBy=multi-user.target";

        fs.writeFileSync("/etc/systemd/system/" + name + ".service", service);
        bash_cmd("chmod +x /etc/systemd/system/" + name + ".service");
        bash_cmd("systemctl daemon-reload");
        bash_cmd("systemctl start " + name + ".service");
        bash_cmd("systemctl enable " + name + ".service");

        console.log("Start:              \x1b[1;32msystemctl start   " + name + ".service\x1b[0m");
        console.log("Stop:               \x1b[1;32msystemctl stop    " + name + ".service\x1b[0m");
        console.log("Start on reboot:    \x1b[1;32msystemctl enable  " + name + ".service\x1b[0m");
        console.log("No start on reboot: \x1b[1;32msystemctl disable " + name + ".service\x1b[0m");
        console.log("Status:             \x1b[1;32msystemctl status  " + name + ".service\x1b[0m");

        console.log("Current status: Running and Start on reboot");
    }
    else {
        console.log("Can't run on background in non-linux systems");
    }
    process.exit();
}
function get_ticker(ticker) {
    return new Promise((resolve, reject) => {

        const js_request = (url, fn) => {
            async_request(url).then(x => {
                try {
                    fn(JSON.parse(x));
                }
                catch (e) { /**/ }
                resolve(exdata);
            }).catch(() => resolve(exdata));
        };
        const ternary_try = (fn_try, res_catch) => {
            try {
                return fn_try();
            }
            catch (e) {
                return res_catch;
            }
        };

        let exdata = new ExchangeData(), tmp, coin_up, coin_lw, exchange;

        if (Array.isArray(ticker)) {
            coin_up = [ticker[1].toUpperCase(), ticker[2].toUpperCase()];
            coin_lw = [ticker[1].toLowerCase(), ticker[2].toLowerCase()];
            exchange = ticker[0];
            exdata.name = `${exchange} (${coin_up[0] !== conf.coin.toUpperCase() ? coin_up[0] + "-" : ""}${coin_up[1]})`;
        }
        else {
            coin_up = [conf.coin.toUpperCase(), "BTC"];
            coin_lw = [conf.coin.toLowerCase(), "btc"];
            exchange = ticker;
            exdata.name = exchange;
        }

        switch (exchange.toLowerCase()) {
            case "altilly": {
                exdata.link = `https://www.altilly.com/market/ZYRK_BTC`;
                js_request(`https://api.altilly.com/api/public/ticker/ZYRKBTC`, res => exdata.fillj(res, "last", "volumeQuote", "bid", "ask", ""));
                break;
            }
            case "cryptobridge": {
                exdata.link = `https://wallet.crypto-bridge.org/market/BRIDGE.${coin_up[0]}_BRIDGE.${coin_up[1]}`;
                js_request(`https://api.crypto-bridge.org/api/v1/ticker/${coin_up[0]}_${coin_up[1]}`, res => exdata.fillj(res, "last", "volume", "bid", "ask", "percentChange"));
                break;
            }
            case "crex24": {
                exdata.link = `https://crex24.com/exchange/${coin_up[0]}-${coin_up[1]}`;
                js_request(`https://api.crex24.com/v2/public/tickers?instrument=${coin_up[0]}-${coin_up[1]}`, res => exdata.fillj(res[0], "last", "volumeInBtc", "bid", "ask", "percentChange"));
                break;
            }
            case "coinexchange": {
                exdata.link = `https://www.coinexchange.io/market/${coin_up[0]}/${coin_up[1]}`;
                js_request(`https://www.coinexchange.io/api/v1/getmarketsummary?market_id=` + conf.special_ticker.CoinExchange, res => exdata.fillj(res["result"], "LastPrice", "BTCVolume", "BidPrice", "AskPrice", "Change"));
                break;
            }
            case "graviex": {
                exdata.link = `https://graviex.net/markets/${coin_lw[0]}${coin_lw[1]}`;
                js_request(`https://graviex.net:443/api/v2/tickers/${coin_lw[0]}${coin_lw[1]}.json`, res => exdata.fillj(res["ticker"], "last", "volbtc", "buy", "sell", "change"));
                break;
            }
            case "escodex": {
                exdata.link = `https://wallet.escodex.com/market/ESCODEX.${coin_up[0]}_ESCODEX.${coin_up[1]}`;
                js_request(`http://labs.escodex.com/api/ticker`, res => exdata.fillj(res.find(x => x.base === coin_up[1] && x.quote === coin_up[0]), "latest", "base_volume", "highest_bid", "lowest_ask", "percent_change"));
                break;
            }
            case "cryptopia": {
                exdata.link = `https://www.cryptopia.co.nz/Exchange/?market=${coin_up[0]}_${coin_up[1]}`;
                js_request(`https://www.cryptopia.co.nz/api/GetMarket/${coin_up[0]}_${coin_up[1]}`, res => exdata.fillj(res["Data"], "LastPrice", "BaseVolume", "AskPrice", "BidPrice", "Change"));
                break;
            }
            case "stex": {
                exdata.link = `https://app.stex.com/en/trade/pair/${coin_up[1]}/${coin_up[0]}`;
                js_request(`https://app.stex.com/api2/ticker`, res => {
                    tmp = res.find(x => x.market_name === `${coin_up[0]}_${coin_up[1]}`);
                    exdata.fill(tmp["last"], (parseFloat(tmp["last"]) + parseFloat(tmp["lastDayAgo"])) / 2 * tmp["vol"], tmp["ask"], tmp["bid"], tmp["lastDayAgo"] !== 0 ? (tmp["last"] / tmp["lastDayAgo"] - 1) * 100 : 0);
                });
                break;
            }
            case "c-cex": {
                exdata.link = `https://c-cex.com/?p=${coin_lw[0]}-{coin_lw[1]}`;
                Promise.all([
                    async_request(`https://c-cex.com/t/${coin_lw[0]}-${coin_lw[1]}.json`).catch(() => { }),
                    async_request(`https://c-cex.com/t/volume_${coin_lw[1]}.json`).catch(() => { })
                ]).then(([ticker, volume]) => {
                    try {
                        exdata.fillj(JSON.parse(ticker)["ticker"], "lastprice", "", "buy", "sell", "");
                        exdata.volume = ternary_try(() => parseFloat(JSON.parse(volume)["ticker"][coin_lw[0]]["vol"]).toFixed(8), "Error");
                    }
                    catch (e) { /**/ }
                    resolve(exdata);
                });
                break;
            }
            case "hitbtc": {
                exdata.link = `https://hitbtc.com/${coin_up[0]}-to-${coin_up[1]}`;
                js_request(`https://api.hitbtc.com/api/2/public/ticker/${coin_up[0]}${coin_up[1]}`, res => exdata.fillj(res, "last", "volumeQuote", "ask", "bid", ""));
                break;
            }
            case "yobit": {
                exdata.link = `https://yobit.net/en/trade/${coin_up[0]}/${coin_up[1]}`;
                js_request(`https://yobit.net/api/2/${coin_lw[0]}_${coin_lw[1]}/ticker`, res => exdata.fillj(res["ticker"], "last", "vol", "buy", "sell", ""));
                break;
            }
            case "bittrex": {
                exdata.link = `https://www.bittrex.com/Market/Index?MarketName=${coin_up[1]}-${coin_up[0]}`;
                js_request(`https://bittrex.com/api/v1.1/public/getmarketsummary?market=${coin_lw[1]}-${coin_lw[0]}`, res => {
                    tmp = res["result"][0];
                    exdata.fill(tmp["Last"], tmp["BaseVolume"], tmp["Bid"], tmp["Ask"], tmp["Last"] / tmp["PrevDay"]);
                });
                break;
            }
            case "southxchange": {
                exdata.link = `https://www.southxchange.com/Market/Book/${coin_up[0]}/${coin_up[1]}`;
                js_request(`https://www.southxchange.com/api/price/${coin_up[0]}/${coin_up[1]}`, res => exdata.fillj(res, "Last", "Volume24Hr", "Bid", "Ask", "Variation24Hr"));
                break;
            }
            case "exrates": {
                exdata.link = `https://exrates.me/dashboard`;
                js_request(`https://exrates.me/openapi/v1/public/ticker?currency_pair=${coin_lw[0]}_${coin_lw[1]}`, res => exdata.fillj(res[0], "last", "quoteVolume", "highestBid", "lowestAsk", "percentChange"));
                break;
            }
            case "binance": {
                exdata.link = `https://www.binance.com/es/trade/${coin_up[0]}_${coin_up[1]}`;
                js_request(`https://api.binance.com/api/v1/ticker/24hr?symbol=${coin_up[0]}${coin_up[1]}`, res => exdata.fillj(res, "lastPrice", "quoteVolume", "bidPrice", "askPrice", "priceChangePercent"));
                break;
            }
            case "bitfinex": {
                exdata.link = `https://www.bitfinex.com/t/${coin_up[0]}:${coin_up[1]}`;
                js_request(`https://api.bitfinex.com/v2/ticker/t${coin_up[0]}${coin_up[1]}`, res => exdata.fill(res[6], (res[8] + res[9]) / 2 * res[7], res[0], res[2], res[5]));
                break;
            }
            case "coinex": {
                exdata.link = `https://www.coinex.com/exchange?currency=${coin_lw[1]}&dest=${coin_lw[0]}#limit`;
                js_request(`https://api.coinex.com/v1/market/ticker?market=${coin_up[0]}${coin_up[1]}`, res => {
                    tmp = res["data"]["ticker"];
                    exdata.fill(tmp["last"], (parseFloat(tmp["high"]) + parseFloat(tmp["low"])) / 2 * tmp["vol"], tmp["buy"], tmp["sell"], tmp["last"] / tmp["open"]);
                });
                break;
            }
            case "p2pb2b": {
                exdata.link = `https://p2pb2b.io/trade/${coin_up[0]}_${coin_up[1]}`;
                js_request(`https://p2pb2b.io/api/v1/public/ticker?market=${coin_up[0]}_${coin_up[1]}`, res => exdata.fillj(res["result"], "last", "deal", "bid", "ask", "change"));
                break;
            }
            case "coinsbit": {
                exdata.link = `https://coinsbit.io/trade/${coin_up[0]}_${coin_up[1]}`;
                js_request(`https://coinsbit.io/api/v1/public/ticker?market=${coin_up[0]}_${coin_up[1]}`, res => exdata.fillj(res["result"], "last", "deal", "bid", "ask", "change"));
                break;
            }
            case "zolex": {
                exdata.link = `https://zolex.org/trading/${coin_lw[0]}${coin_lw[1]}`;
                Promise.all([
                    async_request(`https://zolex.org/api/v2/tickers/${coin_lw[0]}${coin_lw[1]}`).catch(() => { }),
                    async_request(`https://zolex.org/api/v2/k?market=${coin_lw[0]}${coin_lw[1]}&limit=1440&period=1`).catch(() => { })
                ]).then(([res, ohlc]) => {
                    try {
                        res = JSON.parse(res)["ticker"];
                        res.chg = ternary_try(() => {
                            tmp = JSON.parse(ohlc);
                            return tmp[0][1] !== 0 ? (res["last"] / tmp[0][1] - 1) * 100 : 0;
                        }, 0);
                        exdata.fillj(res, "last", "", "buy", "sell", "chg");
                        exdata.volume = ternary_try(() => {
                            let vol = 0.00;
                            for (let x of JSON.parse(ohlc).filter(x => x[5] > 0))
                                vol += x.slice(1, 5).reduce((pv, cv) => pv + cv) / 4 * x[5];
                            return vol.toFixed(8);
                        }, "Error");
                    }
                    catch (e) { /**/ }
                    resolve(exdata);
                });
                break;
            }
            case "tradesatoshi": {
                exdata.link = `https://tradesatoshi.com/Exchange/?market=${coin_up[0]}_${coin_up[1]}`;
                js_request(`https://tradesatoshi.com/api/public/getmarketsummary?market=${coin_up[0]}_${coin_up[1]}`, res => exdata.fillj(res["result"], "last", "baseVolume", "bid", "ask", "change"));
                break;
            }
            case "coinbene": {
                exdata.link = `https://www.coinbene.com/exchange.html#/exchange?pairId=${coin_up[0]}${coin_up[1]}`;
                js_request(`https://api.coinbene.com/v1/market/ticker?symbol=${coin_lw[0]}${coin_lw[1]}`, res => exdata.fillj(res["ticker"][0], "last", "24hrAmt", "bid", "ask", ""));
                break;
            }
            case "finexbox": {
                exdata.link = `https://www.finexbox.com/market/pair/${coin_up[0]}-${coin_up[1]}.html`;
                Promise.all([
                    async_request(`https://xapi.finexbox.com/v1/ticker?market=${coin_lw[0]}_${coin_lw[1]}`).catch(() => { }),
                    async_request(`https://xapi.finexbox.com/v1/orders?market=${coin_lw[0]}_${coin_lw[1]}&count=1`).catch(() => { })
                ]).then(([res, ord]) => {
                    try {
                        res = JSON.parse(res)["result"];
                        ord = JSON.parse(ord)["result"];
                        exdata.fill(res.price, res.volume * res.average, ord.buy.length && ord.buy[0].price, ord.sell.length && ord.sell[0].price);
                    }
                    catch (e) { /**/ }
                    resolve(exdata);
                });
                break;
            }
            case "hotdex": {
                exdata.link = `https://wallet.hotdex.eu/market/HOTDEX.${coin_up[0]}_HOTDEX.${coin_up[1]}`;
                BsApis.instance("wss://bitshares.openledger.info/ws", true).init_promise.then(async () => {
                    try {
                        let ticker = await BsApis.instance().db_api().exec("get_ticker", [`HOTDEX.${coin_up[1]}`, `HOTDEX.${coin_up[0]}`]);
                        exdata.fillj(ticker, "latest", "base_volume", "highest_bid", "lowest_ask", "percent_change");
                    } catch (e) { /**/ }
                    resolve(exdata);
                }).catch(e => resolve(exdata));
                break;
            }
            case "midex": {
                exdata.link = `https://en.midex.com/trade/${coin_up[0]}_${coin_up[1]}`;
                Promise.all([
                    async_request(`https://robot.midex.com/v1/currency_pair/${coin_lw[0]}${coin_lw[1]}/ticker`).catch(() => { }),
                    async_request(`https://robot.midex.com/v1/currency_pair/${coin_lw[0]}${coin_lw[1]}/trades`).catch(() => { })
                ]).then(([res, ord]) => {
                    try {
                        res = JSON.parse(res);
                        ord = JSON.parse(ord);
                        let vol = 0.0;
                        ord.forEach(x => vol += x.price * x.quantity);
                        exdata.fill(ord.length ? ord[0].price : 0, vol, res.buy_price, res.sell_price, res.change24);
                    }
                    catch (e) { /**/ }
                    resolve(exdata);
                });
                break;
            }
            default: {
                resolve(exdata);
            }
        }

    });
}
function price_avg() {
    return new Promise((resolve, reject) => {
        let promises = [];
        for (let ticker of conf.ticker.filter(x => !Array.isArray(x) || x[2].toUpperCase() === "BTC"))
            promises.push(get_ticker(ticker));
        Promise.all(promises).then(values => {
            let price = 0.00, weight = 0.00;
            values = values.filter(x => !isNaN(x.price));
            values.forEach(x => {
                x.volume = isNaN(x.volume) ? 0 : parseFloat(x.volume);
                weight += x.volume;
            });
            values.forEach(x => price += parseFloat(x.price) * (weight !== 0 ? x.volume / weight : 1 / values.length));
            resolve(values.length === 0 ? undefined : price);
        });
    });
}
function price_btc_usd() {
    return new Promise((resolve, reject) => {
        let req = new XMLHttpRequest();
        req.open("GET", "https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD");
        req.onreadystatechange = () => {
            if (req.readyState === 4) {
                if (req.status === 200) {
                    try {
                        resolve(JSON.parse(req.responseText)["USD"]);
                    }
                    catch (e) { /**/ }
                }
                resolve(0);
            }
        };
        req.send();
    });
}
function request_mncount() {
    let cmd_res = bash_cmd(conf.requests.mncount);
    try {
        let json = JSON.parse(cmd_res);
        if (json["enabled"] !== undefined)
            return json["enabled"].toString();
    }
    catch (e) { /**/ }
    cmd_res = cmd_res.toString().replace("\n", "").trim();
    return /^[0-9]+$/.test(cmd_res) ? cmd_res : "";
}
function valid_request(req) {
    return conf.requests[req] !== undefined && conf.requests[req].trim() !== "";
}
function earn_fields(coinday, avgbtc, priceusd) {
    const earn_value = (mult) => {
        return (coinday * mult).toFixed(4) + " " + conf.coin + "\n" +
            (coinday * mult * avgbtc).toFixed(8) + " BTC\n" +
            (coinday * mult * avgbtc * priceusd).toFixed(2) + " USD";
    };
    return [
        {
            name: "Daily",
            value: earn_value(1),
            inline: true
        },
        {
            name: "Weekly",
            value: earn_value(7),
            inline: true
        },
        {
            name: "Monthly",
            value: earn_value(30),
            inline: true
        },
        {
            name: "Yearly",
            value: earn_value(365),
            inline: true
        }
    ];
}
function get_stage(blk) {
    for (let stage of conf.stages)
        if (blk <= stage.block)
            return stage;
    return conf.stages[conf.stages.length - 1];
}
function async_request(url) {
    return new Promise((resolve, reject) => {
        let req = new XMLHttpRequest();
        req.open("GET", url);
        req.onreadystatechange = () => {
            if (req.readyState === 4) {
                if (req.status === 200) {
                    try {
                        resolve(req.responseText);
                        return;
                    }
                    catch (e) { /**/ }
                }
                reject(req.statusText);
            }
        };
        req.send();
    });
}
function bash_cmd(cmd) {
    return (process.platform === "win32" ? spawnSync("cmd.exe", ["/S", "/C", cmd]) : spawnSync("sh", ["-c", cmd])).stdout.toString();
}
function create_no_exists(path, file = false) {
    if (!fs.existsSync(path)) {
        if (file)
            fs.writeFileSync(path, "");
        else
            fs.mkdirSync(path);
    }
}
function simple_message(title, descr, color = conf.color.explorer) {
    return {
        embed: {
            title: title,
            color: color,
            description: descr,
            timestamp: new Date()
        }
    };
}
class BotCommand {

    /** @param {Discord.Message} msg -
      * @param {Function} fn_send - */
    constructor(msg, fn_send = txt => this.msg.channel.send(txt)) {
        this.msg = msg;
        this.fn_send = fn_send;
    }

    price() {
        let promises = [];
        for (let ticker of conf.ticker)
            promises.push(get_ticker(ticker));

        return Promise.all(promises).then(values => {

            const hide_undef = (str, val) => {
                if (val === undefined)
                    return conf.hidenotsupported ? "\n" : str + "Not Supported" + "\n";
                return str + val + "\n";
            };

            let embed = new Discord.RichEmbed();
            embed.title = "Price Ticker";
            embed.color = conf.color.prices;
            embed.timestamp = new Date();

            for (let data of values) {
                embed.addField(
                    data.name,
                    hide_undef("**| Price** : ", data.price) +
                    hide_undef("**| Volume(BTC)** : ", data.volume) +
                    hide_undef("**| Buy** : ", data.buy) +
                    hide_undef("**| Sell** : ", data.sell) +
                    hide_undef("**| Change** : ", data.change) +
                    "[Link](" + data.link + ")",
                    true
                );
            }
            if (embed.fields.length > 3 && embed.fields.length % 3 === 2)
                embed.addBlankField(true);

            this.fn_send(embed);
        });
    }
    stats() {
        return Promise.all([
            new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.blockcount))),
            new Promise((resolve, reject) => resolve(request_mncount())),
            new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.supply)))
        ]).then(([blockcount, mncount, supply]) => {

            let valid = {
                blockcount: !isNaN(blockcount) && blockcount.trim() !== "",
                mncount: !isNaN(mncount) && mncount.trim() !== "",
                supply: !isNaN(supply) && supply.trim() !== ""
            };

            let stage = get_stage(blockcount);
            let stg_index = conf.stages.indexOf(stage);

            let embed = new Discord.RichEmbed();
            embed.title = "Blockchain Statistics";
            embed.color = conf.color.coininfo;
            embed.timestamp = new Date();
            for (let stat of conf.statorder) {
                switch (stat) {
                    case "blockcount": {
                        if (valid.blockcount)
                            embed.addField("Block Count", blockcount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","), true);
                        break;
                    }
                    case "mncount": {
                        if (valid.mncount)
                            embed.addField("Masternode Count", mncount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","), true);
                        break;
                    }
                    case "supply": {
                        if (valid.supply)
                            embed.addField("Supply", parseFloat(supply).toFixed(4).replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin, true);
                        break;
                    }
                }
            }
            if (valid_request("blockcount") && !valid.blockcount)
                embed.description = (embed.description === undefined ? "" : embed.description) + "Error: there is a problem with the `blockcount` request\n";
            if (valid_request("mncount") && !valid.mncount)
                embed.description = (embed.description === undefined ? "" : embed.description) + "Error: there is a problem with the `mncount` request\n";
            if (valid_request("supply") && !valid.supply)
                embed.description = (embed.description === undefined ? "" : embed.description) + "Error: there is a problem with the `supply` request";

            this.fn_send(embed);

        });
    }
    earnings(mns) {
        return Promise.all([
            new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.blockcount))),
            new Promise((resolve, reject) => resolve(request_mncount())),
            new Promise((resolve, reject) => resolve(price_avg())),
            new Promise((resolve, reject) => resolve(price_btc_usd()))
        ]).then(([blockcount, mncount, avgbtc, priceusd]) => {

            let valid = {
                blockcount: !isNaN(blockcount) && blockcount.trim() !== "",
                mncount: !isNaN(mncount) && mncount.trim() !== ""
            };

            if (valid.blockcount && valid.mncount) {
                mns = mns !== undefined && mns > 0 ? mns : 1;
                let stage = get_stage(blockcount);
                let coinday = 86400 / conf.blocktime / mncount * stage.mn;
                this.fn_send({
                    embed: {
                        title: conf.coin + " Earnings" + (mns !== 1 ? " (" + mns + " Masternodes)" : ""),
                        color: conf.color.coininfo,
                        fields: [
                            {
                                name: "ROI:",
                                value: (36500 / (stage.coll / coinday)).toFixed(2) + "%\n" + (stage.coll / coinday).toFixed(2) + " days",
                                inline: true
                            },
                            {
                                name: "Masternode Price:",
                                value: (stage.coll * avgbtc).toFixed(8) + " BTC\n" + (stage.coll * avgbtc * priceusd).toFixed(2) + " USD",
                                inline: true
                            }
                        ].concat(mns === 1 ? [{ name: "\u200b", value: "\u200b", inline: true }] : [
                            {
                                name: "Aquire 1 Masternode in:",
                                value: (stage.coll / (coinday * mns)).toFixed(2) + " days",
                                inline: true
                            }
                        ]).concat(earn_fields(coinday * mns, avgbtc, priceusd)),
                        timestamp: new Date()
                    }
                });
            }
            else {
                this.fn_send({
                    embed: {
                        title: conf.coin + " Earnings",
                        color: conf.color.coininfo,
                        description: (valid.blockcount ? "" : "Error: there is a problem with the `blockcount` request\n") + (valid.mncount ? "" : "Error: there is a problem with the `mncount` request"),
                        timestamp: new Date()
                    }
                });
            }
        });
    }
    mining(hr, mult) {
        let letter = "";

        const calc_multiplier = () => {
            if (mult !== undefined)
                switch (mult.toUpperCase()) {
                    case "K": case "KH": case "KHS": case "KH/S": case "KHASH": case "KHASHS": case "KHASH/S":
                        letter = "K";
                        return hr * 1000;
                    case "M": case "MH": case "MHS": case "MH/S": case "MHASH": case "MHASHS": case "MHASH/S":
                        letter = "M";
                        return hr * 1000 * 1000;
                    case "G": case "GH": case "GHS": case "GH/S": case "GHASH": case "GHASHS": case "GHASH/S":
                        letter = "G";
                        return hr * 1000 * 1000 * 1000;
                    case "T": case "TH": case "THS": case "TH/S": case "THASH": case "THASHS": case "THASH/S":
                        letter = "T";
                        return hr * 1000 * 1000 * 1000 * 1000;
                }
            return hr;
        };

        if (/^[0-9.\n]+$/.test(hr)) {
            Promise.all([
                new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.blockcount))),
                new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.hashrate))),
                new Promise((resolve, reject) => resolve(price_avg())),
                new Promise((resolve, reject) => resolve(price_btc_usd()))
            ]).then(([blockcount, total_hr, avgbtc, priceusd]) => {

                let valid = {
                    blockcount: !isNaN(blockcount) && blockcount.trim() !== "",
                    mncount: !isNaN(total_hr) && total_hr.trim() !== ""
                };

                if (valid.blockcount && valid.mncount) {
                    let stage = get_stage(blockcount);
                    let coinday = 86400 / conf.blocktime * stage.pow * calc_multiplier() / total_hr;
                    this.fn_send({
                        embed: {
                            title: conf.coin + " Mining (" + hr + " " + letter + "H/s)",
                            color: conf.color.coininfo,
                            description: stage.pow === undefined ? "POW disabled in the current coin stage" : "",
                            fields: stage.pow === undefined ? [] : earn_fields(coinday, avgbtc, priceusd),
                            timestamp: new Date()
                        }
                    });
                }
                else {
                    this.fn_send(simple_message(conf.coin + " Mining (" + hr + " " + letter + "H/s)",
                        (valid.blockcount ? "" : "Error: there is a problem with the `blockcount` request\n") +
                        (valid.hashrate ? "" : "Error: there is a a problem with the `hashrate` request"),
                        conf.color.coininfo,
                    ));
                }
            });
        }
        else {
            this.fn_send({
                embed: {
                    title: conf.coin + " Mining ( ? H/s)",
                    color: conf.color.coininfo,
                    description: "Invalid Hashrate"
                }
            });
        }
    }
    addnodes() {
        new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.addnodes))).then(info => {
            try {
                let str = "";
                JSON.parse(info).slice(0, 16).forEach(x => str += `addnode=${x.addr}\n`);
                this.fn_send(simple_message("Network Peers", "```ini\n" + str + "\n```", 5198940));
            }
            catch (e) {
                this.msg.send(simple_message("Addnodes", "Error: there is a problem with the `addnodes` request", conf.color.coininfo));
            }
        });
    }
    balance(addr) {
        try {
            let json = JSON.parse(bash_cmd(conf.requests.balance + addr));
            if (json["sent"] !== undefined && json["received"] !== undefined && json["balance"] !== undefined) {
                this.fn_send({
                    embed: {
                        title: "Balance:",
                        color: conf.color.explorer,
                        fields: [
                            {
                                name: "Address:",
                                value: addr
                            },
                            {
                                name: "Sent:",
                                value: json["sent"].toString().replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin,
                                inline: true
                            },
                            {
                                name: "Received:",
                                value: json["received"].toString().replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin,
                                inline: true
                            },
                            {
                                name: "Balance:",
                                value: json["balance"].toString().replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin,
                                inline: true
                            }
                        ],
                        timestamp: new Date()
                    }
                });
                return;
            }
        }
        catch (e) { /**/ }
        this.fn_send(simple_message("Balance", "Error: Invalid address `" + addr + "`\n(Your address must contain atleast 1 transaction to be considered valid)"));
    }
    block_index(index) {
        this.block_hash(bash_cmd(conf.requests.blockindex + index));
    }
    block_hash(hash) {
        let str = "Invalid block index or hash";

        if (/^[A-Za-z0-9\n]+$/.test(hash)) {
            try {
                let json = JSON.parse(bash_cmd(conf.requests.blockhash + hash));
                str =
                    "**Height:** " + json["height"] + "\n" +
                    "**Hash:** " + json["hash"] + "\n" +
                    "**Confirmations:** " + json["confirmations"] + "\n" +
                    "**Size:** " + json["size"] + "\n" +
                    "**Date:** " + new Date(new Number(json["time"]) * 1000).toUTCString() + "\n" +
                    "**Prev Hash:** " + json["previousblockhash"] + "\n" +
                    "**Next Hash:** " + json["nextblockhash"] + "\n" +
                    "**Transactions:**\n";
                for (let i = 0; i < json["tx"].length; i++)
                    str += json["tx"][i] + "\n";
            }
            catch (e) { /**/ }
        }
        this.fn_send({
            embed: {
                title: "Blockchain Info",
                color: conf.color.explorer,
                description: str
            }
        });
    }
    my_address_add(addrs) {
        create_no_exists(users_addr_folder);
        for (let addr of addrs) {
            try {
                let json = JSON.parse(bash_cmd(conf.requests.balance + addr));
                if (json["sent"] !== undefined && json["received"] !== undefined && json["balance"] !== undefined) {
                    let addrs_list = fs.existsSync(users_addr_folder + "/" + this.msg.author.id + ".txt") ? fs.readFileSync(users_addr_folder + "/" + this.msg.author.id + ".txt", "utf8").split(/\r?\n/) : [];
                    if (addrs_list.indexOf(addr) === -1) {
                        fs.writeFileSync(users_addr_folder + "/" + this.msg.author.id + ".txt", addrs_list.concat([addr]).join("\n"));
                        this.fn_send(simple_message("Add Address", "Address `" + addr + "` is assigned to <@" + this.msg.author.id + ">"));
                    }
                    else {
                        this.fn_send(simple_message("Add ADdress", "Address `" + addr + "` is already assigned to <@" + this.msg.author.id + ">"));
                    }
                    continue;
                }
            }
            catch (e) { /**/ }
            this.fn_send(simple_message("Address Add", "Error: Invalid Address `" + addr + "`\n(Your address must contain atleast 1 transaction to be considered valid)"));
        }
    }
    my_address_del(addrs) {
        create_no_exists(users_addr_folder);
        for (let addr of addrs) {
            if (!fs.existsSync(users_addr_folder + "/" + this.msg.author.id + ".txt")) {
                this.fn_send(simple_message("Address Delete", "There currently aren't any addresses assigned to <@" + this.msg.author.id + ">"));
                return;
            }
            let addrs_list = fs.readFileSync(users_addr_folder + "/" + this.msg.author.id + ".txt", "utf8").split(/\r?\n/).filter(Boolean);
            let index = addrs_list.indexOf(addr);
            if (index !== -1) {
                addrs_list.splice(index, 1);
                if (addrs_list.length)
                    fs.writeFileSync(users_addr_folder + "/" + this.msg.author.id + ".txt", addrs_list.join("\n"));
                else
                    fs.unlinkSync(users_addr_folder + "/" + this.msg.author.id + ".txt");
                this.fn_send(simple_message("Address Delete", "Address `" + addr + "` has been deleted from <@" + this.msg.author.id + "> assigned addresses"));
            }
            else {
                this.fn_send(simple_message("Address Delete", "Address `" + addr + "` isn't currently assgined to <@" + this.msg.author.id + ">\nPlease use `" + conf.prefix + "my-address-list` to see your current addresses"));
            }
        }
    }
    my_address_list() {
        create_no_exists(users_addr_folder);
        if (!fs.existsSync(users_addr_folder + "/" + this.msg.author.id + ".txt")) {
            this.fn_send(simple_message("Address List", "There currently aren't any addresses assigned to <@" + this.msg.author.id + ">\nPlease use `" + conf.prefix + "my-address-add ZYRK_ADDRESS` to assign an addresses to yourself"));
            return;
        }

        let addr_str = "`" + fs.readFileSync(users_addr_folder + "/" + this.msg.author.id + ".txt", "utf8").split(/\r?\n/).filter(Boolean).join("`, `") + "`";
        if (addr_str.length < 2000) {
            this.fn_send(simple_message("Address List", addr_str));
        }
        else {
            this.fn_send(simple_message("Address List", "Your address list is too large, has been sent as a dm to you"));
            this.msg.author.send(addr_str);
        }
    }
    my_balance() {
        create_no_exists(users_addr_folder);
        if (!fs.existsSync(users_addr_folder + "/" + this.msg.author.id + ".txt")) {
            this.fn_send(simple_message("Your Balance", "There currently aren't any addresses assigned to <@" + this.msg.author.id + ">\nPlease use `" + conf.prefix + "my-address-add ZYRK_ADDRESS` to assign an addresses to yourself"));
            return;
        }

        let sent = 0.00, recv = 0.00, bal = 0.00;
        for (let addr of fs.readFileSync(users_addr_folder + "/" + this.msg.author.id + ".txt", "utf-8").split(/\r?\n/).filter(Boolean)) {
            try {
                let json = JSON.parse(bash_cmd(conf.requests.balance + addr));
                if (json["sent"] !== undefined && json["received"] !== undefined && json["balance"] !== undefined) {
                    sent += parseFloat(json["sent"]);
                    recv += parseFloat(json["received"]);
                    bal += parseFloat(json["balance"]);
                }
            }
            catch (e) {
                //
            }
        }
        this.fn_send({
            embed: {
                title: "Your Balance",
                color: conf.color.explorer,
                fields: [
                    {
                        name: "Sent:",
                        value: sent.toString().replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin,
                        inline: true
                    },
                    {
                        name: "Received:",
                        value: recv.toString().replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin,
                        inline: true
                    },
                    {
                        name: "Balance:",
                        value: bal.toString().replace(/(\d)(?=(?:\d{3})+(?:\.|$))|(\.\d{4}?)\d*$/g, (m, s1, s2) => s2 || s1 + ',') + " " + conf.coin,
                        inline: true
                    }
                ],
                timestamp: new Date()
            }
        });
    }
    my_masternode_add(addrs) {
        create_no_exists(users_mn_folder);
        for (let addr of addrs) {
            try {
                let json = JSON.parse(bash_cmd(conf.requests.mnstat + addr));
                if (Array.isArray(json))
                    json = json[0];
                if (json["status"] !== undefined && json["addr"] === addr) {
                    let addrs_list = fs.existsSync(users_mn_folder + "/" + this.msg.author.id + ".txt") ? fs.readFileSync(users_mn_folder + "/" + this.msg.author.id + ".txt", "utf8").split(/\r?\n/) : [];
                    if (addrs_list.indexOf(addr) === -1) {
                        fs.writeFileSync(users_mn_folder + "/" + this.msg.author.id + ".txt", addrs_list.concat([addr]).join("\n"));
                        this.fn_send(simple_message("Masternode Add", "Masternode Address `" + addr + "` has been assigned to <@" + this.msg.author.id + ">\nStatus: " + json["status"]));
                    }
                    else {
                        this.fn_send(simple_message("Masternode Add", "Masternode Address `" + addr + "` is already assigned to <@" + this.msg.author.id + ">"));
                    }
                }
            }
            catch (e) {
                this.fn_send(simple_message("Masternode Add", "Error: Invalid Masternode Adddress `" + addr + "`\n(Masternode cannot be found on network)"));
            }
        }
    }
    my_masternode_del(addrs) {
        create_no_exists(users_mn_folder);
        for (let addr of addrs) {
            if (!fs.existsSync(users_mn_folder + "/" + this.msg.author.id + ".txt")) {
                this.fn_send(simple_message("Masternode Delete", "There aren no Masternodes assigned to <@" + this.msg.author.id + ">"));
                return;
            }
            let addrs_list = fs.readFileSync(users_mn_folder + "/" + this.msg.author.id + ".txt", "utf8").split(/\r?\n/).filter(Boolean);
            let index = addrs_list.indexOf(addr);
            if (index !== -1) {
                addrs_list.splice(index, 1);
                if (addrs_list.length)
                    fs.writeFileSync(users_mn_folder + "/" + this.msg.author.id + ".txt", addrs_list.join("\n"));
                else
                    fs.unlinkSync(users_mn_folder + "/" + this.msg.author.id + ".txt");
                this.fn_send(simple_message("Masternode Delete", "Masternode Address `" + addr + "` has been deleted from <@" + this.msg.author.id + "> assigned Masternodes"));
            }
            else {
                this.fn_send(simple_message("Masternode Delete", "Masternode Address `" + addr + "` is not currently assgined to <@" + this.msg.author.id + ">\nPlease use `" + conf.prefix + "my-masternode-list` to get your currently assigned Masternodes"));
            }
        }
    }
    my_masternode_list() {
        create_no_exists(users_mn_folder);
        if (!fs.existsSync(users_mn_folder + "/" + this.msg.author.id + ".txt")) {
            this.fn_send(simple_message("Masternode List", "There aren't any Masternodes assigned to <@" + this.msg.author.id + ">\nPlease use `" + conf.prefix + "my-masternode-add MASTERNODE_ADDRESS` to assign a Masternode to yourself"));
            return;
        }

        let mn_str = "";

        for (let addr of fs.readFileSync(users_mn_folder + "/" + this.msg.author.id + ".txt", "utf8").split(/\r?\n/).filter(Boolean)) {
            mn_str += "`" + addr + "`";
            try {
                let json = JSON.parse(bash_cmd(conf.requests.mnstat + addr));
                if (Array.isArray(json))
                    json = json[0];
                if (json["status"] !== undefined && json["addr"] !== undefined)
                    mn_str += " : " + json["status"] + "\n";
            }
            catch (e) {
                mn_str += " : NOT_FOUND\n";
            }
        }

        if (mn_str.length < 2000) {
            this.fn_send(simple_message("Masternode List", mn_str));
        }
        else {
            let mn_split = mn_str.split(/\r?\n/);
            let splits = parseInt(mn_split.length / 30) + 1;
            for (let i = 1; mn_split.length > 0; i++)
                this.fn_send(simple_message("Masternode List (" + i + "/" + splits + ")", mn_split.splice(0, 30).join("\n")));
        }
    }
    my_earnings() {
        create_no_exists(users_mn_folder);
        if (!fs.existsSync(users_mn_folder + "/" + this.msg.author.id + ".txt")) {
            this.fn_send(simple_message("My Earnings", "There aren't any Masternodes assigned to <@" + this.msg.author.id + ">\nPlease use `" + conf.prefix + "my-masternode-add MASTERNODE_ADDRESS` to assign a Masternode to yourself"));
            return;
        }

        Promise.all([
            new Promise((resolve, reject) => resolve(bash_cmd(conf.requests.blockcount))),
            new Promise((resolve, reject) => resolve(request_mncount())),
            new Promise((resolve, reject) => resolve(price_avg())),
            new Promise((resolve, reject) => resolve(price_btc_usd()))
        ]).then(([blockcount, mncount, avgbtc, priceusd]) => {

            let valid = {
                blockcount: !isNaN(blockcount) && blockcount.trim() !== "",
                mncount: !isNaN(mncount) && mncount.trim() !== ""
            };

            let mns = fs.readFileSync(users_mn_folder + "/" + this.msg.author.id + ".txt", "utf-8").split(/\r?\n/).filter(Boolean).length;

            if (valid.blockcount && valid.mncount) {
                let stage = get_stage(blockcount);
                let coinday = 86400 / conf.blocktime / mncount * stage.mn;
                this.fn_send({
                    embed: {
                        title: "Your Earnings (" + mns + " Masternodes)",
                        color: conf.color.coininfo,
                        fields: [
                            {
                                name: "Aquire 1 Masternode in",
                                value: (stage.coll / (coinday * mns)).toFixed(2) + " days"
                            }
                        ].concat(earn_fields(coinday * mns, avgbtc, priceusd)),
                        timestamp: new Date()
                    }
                });
            }
            else {
                this.fn_send({
                    embed: {
                        title: "Your Earnings (" + mns + " Masternodes)",
                        color: conf.color.coininfo,
                        description: (valid.blockcount ? "" : "Error: there is a problem with the `blockcount` request\n") + (valid.mncount ? "" : "Error: there is a problem with the `mncount` request"),
                        timestamp: new Date()
                    }
                });
            }
        });
    }
    help() {
        this.fn_send({
            embed: {
                title: "ZyrkBot Commands",
                color: conf.color.other,
                fields: [
                    {
                        name: "Exchanges:",
                        value:
                            " - **" + conf.prefix + "price" + "** : get the current price of Zyrk on listed exchanges"
                    },
                    {
                        name: "Zyrk Information:",
                        value:
                            " - **" + conf.prefix + "stats** : get the current stats of the Zyrk network\n" +
                            " - **" + conf.prefix + "addnodes** : get a list of current addnodes for the Zyrk netowrk "
                    },
                    {
                        name: "Block Explorer",
                        value:
                            " - **" + conf.prefix + "balance <address>** : show the current balance, received and sent for given address\n" +
                            " - **" + conf.prefix + "block-height <number>** : show block information by given height\n" +
                            " - **" + conf.prefix + "block-hash <hash>** : show block information by given hash"
                    },
                    {
                        name: "My Address",
                        value:
                            " - **" + conf.prefix + "my-address-add <address>** : adds a Zyrk address you own\n" +
                            " - **" + conf.prefix + "my-address-del <address>** : removes a Zyrk address you own\n" +
                            " - **" + conf.prefix + "my-address-list** : shows all added Zyrk addresses\n" +
                            " - **" + conf.prefix + "my-balance** : shows your total balance, received and sent for added addresses"
                    },
                ]
            }
        });
    }
    conf_get() {
        this.fn_send("<@" + this.msg.author.id + "> check your personal messages.");
        this.msg.author.send({ files: [config_json_file] });
    }
    conf_set() {
        this.fn_send("<@" + this.msg.author.id + "> check your personal messages.");
        this.msg.author.send("Drag and drop a config.json here, don't send any message. You have 90 seconds to put the file or you'll have to use **!conf-set** again.").then(reply => {
            let msgcol = new Discord.MessageCollector(reply.channel, m => m.author.id === this.msg.author.id, { time: 90000 });
            msgcol.on("collect", async (elem, col) => {
                msgcol.stop("received");
                if (elem.attachments.array()[0]["filename"] !== "config.json") {
                    this.msg.author.send("Error: file is not config.json");
                    return;
                }
                try {
                    let conf_res = await async_request(elem.attachments.array()[0]["url"]);
                    conf_res = conf_res.slice(conf_res.indexOf("{"));
                    JSON.parse(conf_res);
                    fs.writeFileSync(config_json_file, conf_res);
                    this.fn_send("ZyrkBot config updated by <@" + this.msg.author.id + ">, Rebooting now to apply changes.").then(() => process.exit());
                }
                catch (e) {
                    this.msg.author.send("Something is wrong with new configuration file. Please check and try again.");
                }
            });
            msgcol.on("end", (col, reason) => {
                if (reason === "time")
                    this.msg.author.send("Timeout: please use **!conf-set** again to send a new config.json");
            });
        });
    }

}
function handle_child() {
    let child = spawn(process.argv[0], [process.argv[1], "handled_child"], { stdio: ["ignore", process.stdout, process.stderr, "ipc"] });
    child.on("close", (code, signal) => {
        child.kill();
        for (let i = 5; i > 0; i--) {
            console.log("Restarting ZyrkBot in " + i + " seconds...");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        handle_child();
    });
    child.on("disconnect", () => child.kill());
    child.on("error", () => child.kill());
    child.on("exit", (code, signal) => child.kill());
}
process.on("uncaughtException", err => {
    console.log("Global exception caught:");
    console.log("Name: " + err.name);
    console.log("Message: " + err.message);
    console.log("Stack:" + err.stack);
    process.exit();
});
process.on("unhandledRejection", err => {
    console.log("Global rejection handled:");
    console.log("Name: " + err.name);
    console.log("Message: " + err.message);
    console.log("Stack:" + err.stack);
    process.exit();
});
client.on("message", msg => {

    if (conf.channel.length && !conf.channel.includes(msg.channel.id) || !msg.content.startsWith(conf.prefix) || msg.author.bot)
        return;

    let args = msg.content.slice(conf.prefix.length).split(/[ \r\n]/).filter(x => x.length);
    let cmd = new BotCommand(msg);

    const error_noparam = (n, descr) => {
        if (args.length > n)
            return false;
        msg.channel.send({
            embed: {
                title: "Error: Incorrect Command",
                color: conf.color.error,
                description: descr
            }
        });
        return true;
    };
    const error_noworthy = () => {
        if (conf.devs.indexOf(msg.author.id) > -1)
            return false;
        msg.channel.send({
            embed: {
                title: "Error: Admin Command",
                color: conf.color.error,
                description: "<@" + msg.author.id + "> you are not a staff member."
            }
        });
        return true;
    };
    const enabled_cmd = (name, valid) => {
        if (valid)
            return true;
        msg.channel.send({
            embed: {
                title: "**" + conf.prefix + name + " command**",
                color: conf.color.other,
                description: conf.prefix + name + " disabled in the bot configuration"
            }
        });
        return false;
    };
    switch (args[0]) {

        case "price": {
            cmd.price();
            break;
        }
        case "stats": {
            if (enabled_cmd("stats", valid_request("blockcount") || valid_request("mncount") || valid_request("supply")))
                cmd.stats();
            break;
        }
        case "addnodes": {
            if (enabled_cmd("addnodes", valid_request("addnodes")))
                cmd.addnodes();
            break;
        }
        case "balance": {
            if (enabled_cmd("balance", valid_request("balance")) && !error_noparam(1, "You need to provide an address"))
                cmd.balance(args[1]);
            break;
        }
        case "block-height": {
            if (enabled_cmd("block-index", valid_request("blockhash") && valid_request("blockindex")) && !error_noparam(1, "You need to provide a block number"))
                cmd.block_index(args[1]);
            break;
        }
        case "block-hash": {
            if (enabled_cmd("block-hash", valid_request("blockhash")) && !error_noparam(1, "You need to provide a block hash"))
                cmd.block_hash(args[1]);
            break;
        }
        case "my-address-add": {
            if (enabled_cmd("my-address-add", conf.useraddrs || valid_request("balance")) && !error_noparam(1, "You need to provide at least one Zyrk address"))
                cmd.my_address_add(args.slice(1));
            break;
        }
        case "my-address-del": {
            if (enabled_cmd("my-address-del", conf.useraddrs || valid_request("balance")) && !error_noparam(1, "You need to provide at least one Zyrk address"))
                cmd.my_address_del(args.slice(1));
            break;
        }
        case "my-address-list": {
            if (enabled_cmd("my-address-list", conf.useraddrs || valid_request("balance")))
                cmd.my_address_list();
            break;
        }
        case "my-balance": {
            if (enabled_cmd("my-balance", conf.useraddrs || valid_request("balance")))
                cmd.my_balance();
            break;
        }
        case "help": {
            cmd.help();
            break;
        }
        case "zyrk-easter": {
            msg.channel.send({
                embed: {
                    title: "Easter Egg",
                    color: conf.color.other,
                    description: "Congratulations for finding me, send a staff member your Zyrk address to be rewarded!"
                }
            });
            break;
        }
        case "conf-get": {
            if (!error_noworthy())
                cmd.conf_get();
            break;
        }
        case "conf-set": {
            if (!error_noworthy())
                cmd.conf_set();
            break;
        }

    }

});

if (conf.ticker.some(x => ["hotdex"].includes((Array.isArray(x) ? x[0] : x).toLowerCase()))) {
    try {
        BsApis = require("bitsharesjs-ws").Apis;
    } catch (e) {
        console.log("ERROR: you need to type 'npm install bitsharesjs-ws' to use one or some of the exchanges in the config file");
        return;
    }
}

if (process.argv.length >= 3 && process.argv[2] === "background")
    configure_systemd("discord_bot");
else if (process.argv.length >= 3 && process.argv[2] === "handled_child")
    client.login(conf.token).then(() => {
        console.log("ZyrkBot Ready!");
        start_monitor();
    });
else
    handle_child();