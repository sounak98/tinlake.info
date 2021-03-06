import { gql } from "@apollo/client";
import { graphClient } from "./graphsource";
import { thunk, action, createStore } from "easy-peasy";
import { BigNumber } from "bignumber.js";
import { parseDecimal } from "./format";
import config from "./config";

const loaders = [];

const poolsQuery = gql`
  query {
    pools {
      id
      shortName
      assetValue
      reserve
      totalRepaysAggregatedAmount
    }
  }
`;

loaders.push((actions) => {
  return graphClient
    .query({ query: poolsQuery })
    .then((query) => {
      let pools = query.data.pools.filter(
        (p) => config.ignorePools.indexOf(p.id) < 0
      );
      return pools.map((pool) => {
        let assetValue = parseDecimal(pool.assetValue);
        let reserve = parseDecimal(pool.reserve);
        let poolSize = assetValue.plus(reserve);
        return {
          key: pool.id,
          name: pool.shortName,
          assetValue: assetValue,
          reserve: reserve,
          poolSize: poolSize,
          totalOriginated: parseDecimal(pool.totalRepaysAggregatedAmount).plus(
            assetValue
          ),
        };
      });
    })
    .then((res) => {
      let pools = {};
      res.forEach((p) => {
        pools[p.key] = p;
      });
      let totalValueLocked = Object.values(pools).reduce((t, p) => {
        return t.plus(p.poolSize);
      }, new BigNumber("0"));
      actions.set({ key: "pools", value: pools });
      actions.set({ key: "totalValueLocked", value: totalValueLocked });
    });
});


const msInDay = 24*60*60*1000
const startingDay = parseInt(new Date(new Date().getTime() - new Date().getTime() % msInDay - 90*msInDay).getTime()/1000)

const dailyAssetValue = gql`
query {
  days (orderBy: id, orderDirection: asc, where: {id_gt: "${startingDay}"}) {
    id
    reserve
    assetValue
  }
}`;

loaders.push((actions) => {
  return graphClient.query({ query: dailyAssetValue }).then((query) => {
    actions.set({ key: "dailyAssetValue", value: query.data });
  });
});

const loanData = gql`
  query {
    loans (first:1000) {
      id
      pool {
        id
      }
      opened
      closed
      borrowsAggregatedAmount
      repaysAggregatedAmount
    }
  }
`;

const secondsInWeek = 60 * 60 * 24 * 7;
const getWeek = (d) => {
  return secondsInWeek * Math.floor(d / secondsInWeek);
};

loaders.push((actions) => {
  return graphClient.query({ query: loanData }).then((query) => {
    let loans = query.data.loans.filter(
      (l) => config.ignorePools.indexOf(l.pool.id) < 0
    );
    loans = loans.map((l) => {
      let amount = parseDecimal(l.repaysAggregatedAmount);
      if (l.closed == null) amount = parseDecimal(l.borrowsAggregatedAmount);
      return {
        key: l.id,
        dateOpened: new Date(parseInt(l.opened) * 1000),
        amount: amount,
      };
    });
    let totalOriginated = loans.reduce((o, l) => {
      return o.plus(l.amount);
    }, new BigNumber("0"));
    let start = getWeek(1588707251 + secondsInWeek * 24);
    let stop = getWeek(new Date().getTime() / 1000);
    let empty = {};
    for (let i = start; i <= stop; i += secondsInWeek) {
      empty[i] = { date: i, count: 0, amount: new BigNumber("0") };
    }
    let weeks = loans.reduce((w, l) => {
      let date = getWeek(l.dateOpened.getTime() / 1000);
      if (date < start) {
        return w;
      }
      let week = w[date];
      week.amount = week.amount.plus(l.amount);
      week.count += 1;
      w[date] = week;
      return w;
    }, empty);
    actions.set({ key: "weeklyOriginations", value: Object.values(weeks) });
    actions.set({ key: "loans", value: loans });
    actions.set({ key: "totalLoans", value: loans.length });
    actions.set({ key: "totalOriginated", value: totalOriginated });
  });
});

// orderBy: day__id, orderDirection: asc, where: {day__id_gt: "${startingDay}"},
let ditbQuery = (offset) => {
  offset = offset * 1000
  return graphClient.query({ query: gql`
{
  dailyInvestorTokenBalances (skip: ${offset}, first:1000, orderBy: id, orderDirection: desc) {
    pool {
      id
    }
    account {
      id
    }
    day {
      id
    }
    seniorTokenValue
    juniorTokenValue
  }
}
`})
}

loaders.push((actions) => {
    let queries = []
    const loops = 15
    for (let i = 0; i < loops; i++) {
      queries.push(ditbQuery(i))
    }
    return Promise.all(queries)
    .then((query) => {
        if (query[loops-1].data.dailyInvestorTokenBalances.length === 1000) return;
        let days = {}
        query.forEach((query) => {
          query.data.dailyInvestorTokenBalances.forEach((ditb) => {
            let day = ditb.day.id
            if (days[day] == null) days[day] = { balances: {}, count: 0, total: new BigNumber("0")}
            //let balanceKey = ditb.pool.id + ditb.account.id
            let value = parseDecimal(ditb.seniorTokenValue).plus(parseDecimal(ditb.juniorTokenValue))
            // days[day].balances[balanceKey] = {account: ditb.account.id, pool: ditb.pool.id, value: value}
            days[day].total = days[day].total.plus(value)
            days[day].count += 1
          })
        })


        Object.keys(days).forEach((k) => {
          days[k].average = days[k].total.div(days[k].count)
        })
        actions.set({key: 'dailyUsers', value: days})
    })
})



const store = createStore({
  pools: {},
  loans: {},
  weeklyOriginations: [],
  dailyAssetValue: { days: [] },
  totalOriginated: new BigNumber("0"),
  totalValueLocked: new BigNumber("0"),
  totalAssetValue: new BigNumber("0"),
  dailyUsers: {},
  totalLoans: 0,
  set: action((state, payload) => {
    state[payload.key] = payload.value;
  }),
  loadData: thunk(async (actions, payload) => {
    return Promise.all(
      loaders.map((fn) => {
        return fn(actions);
      })
    );
  }),
});

export { store, loaders };
