import { check, fail } from 'k6';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import remote from 'k6/x/remotewrite';

import { Httpx } from 'https://jslib.k6.io/httpx/0.0.6/index.js';

/**
 * Mimir hostname to connect to on the write path.
 * @constant {string}
 */
const WRITE_HOSTNAME = __ENV.K6_WRITE_HOSTNAME || fail('K6_WRITE_HOSTNAME environment variable missing: set it to the ingress hostname on the write path (eg. distributor hostname)');
/**
 * Mimir hostname to connect to on the read path.
 * @constant {string}
 */
const READ_HOSTNAME = __ENV.K6_READ_HOSTNAME || fail('K6_READ_HOSTNAME environment variable missing: set it to the ingress hostname on the read path (eg. query-frontend hostname)');
/**
 * Configures the protocol scheme used for requests.
 * @constant {string}
 */
const SCHEME = __ENV.K6_SCHEME || 'http';
/**
 * Username to use for HTTP bearer authentication.
 * @constant {string}
 */
const USERNAME = __ENV.K6_USERNAME || '';
/**
 * Authentication token to use for HTTP bearer authentication on requests to write path.
 * @constant {string}
*/
const WRITE_TOKEN = __ENV.K6_WRITE_TOKEN || '';
/**
 * Authentication token to use for HTTP bearer authentication on requests to read path.
 * @constant {string}
*/
const READ_TOKEN = __ENV.K6_READ_TOKEN || '';
/**
 * Number of remote write requests to send every SCRAPE_INTERVAL_SECONDS.
 * Note that the effective rate is multipled by HA_REPLICAS.
 * @constant {number}
 */
const WRITE_REQUEST_RATE = parseInt(__ENV.K6_WRITE_REQUEST_RATE || 1);
/**
 * Number of series per remote write request.
 * @constant {number}
 */
const WRITE_SERIES_PER_REQUEST = parseInt(__ENV.K6_WRITE_SERIES_PER_REQUEST || 1000);

const READ_SERIES_PER_REQUEST = parseInt(__ENV.K6_READ_SERIES_PER_REQUEST || 1000);
/**
 * Total number of unique series to generate and write.
 * @constant {number}
 */
const TOTAL_SERIES = WRITE_REQUEST_RATE * WRITE_SERIES_PER_REQUEST;
/**
 * Number of query requests per second.
 * @constant {number}
 */
const READ_REQUEST_RATE = parseInt(__ENV.K6_READ_REQUEST_RATE ||  1);
/**
 * Duration of the load test in minutes (including ramp up and down).
 * @constant {number}
 */
const DURATION_MIN = parseInt(__ENV.K6_DURATION_MIN || (12*60));
/**
 * Duration of the ramp up period in minutes.
 * @constant {number}
 */
const RAMP_UP_MIN = parseInt(__ENV.K6_RAMP_UP_MIN || 0);
/**
 * Duration of the ramp down period in minutes.
 * @constant {number}
 */
const RAMP_DOWN_MIN = parseInt(__ENV.K6_RAMP_DOWN_MIN || 0);
/**
 * Simulated Prometheus scrape interval in seconds.
 * @constant {number}
 */
const SCRAPE_INTERVAL_SECONDS = parseInt(__ENV.K6_SCRAPE_INTERVAL_SECONDS || 15);
/**
 * Number of HA replicas to simulate (use 1 for no HA).
 * Causes every series to be sent this number of times.
 * @constant {number}
 */
const HA_REPLICAS = parseInt(__ENV.K6_HA_REPLICAS || 1);
/**
 * Tenant ID to read from/write to.
 * By default, no tenant ID is specified requiring the cluster to have multi-tenancy disabled.
 * @constant {string}
*/
const TENANT_ID = __ENV.K6_TENANT_ID || '';

const remote_write_url = get_remote_write_url();
console.debug("Remote write URL:", remote_write_url)

const write_client = new remote.Client({ url: remote_write_url, timeout: '32s', tenant_name: TENANT_ID });

const query_client_headers = {
    'User-Agent': 'k6-load-test',
    "Content-Type": 'application/x-www-form-urlencoded',
}

get_read_authentication_headers().forEach((value, key) => {
    query_client_headers[key] = value
})

const query_client = new Httpx({
    baseURL: `${SCHEME}://${READ_HOSTNAME}/prometheus/api/v1`,
    headers: query_client_headers,
    timeout: 1200e3 // 1200s timeout.
});

/**
 * Exported configuration options for the k6 workers.
 * @constant {object}
 */
export const options = {
    thresholds: {
        // SLA: 99.9% of writes succeed.
        'checks{type:write}': ['rate > 0.999'],
        // 99.9% of writes take less than 10s (SLA has no guarantee on write latency).
        [`http_req_duration{url:${remote_write_url}}`]: ['p(99.9) < 10000'],
        // SLA: 99.9% of queries succeed.
        'checks{type:read}': ['rate > 0.999'],
        // SLA: average query time for any 3 hours of data is less than 2s (not including Internet latency).
        'http_req_duration{type:read}': ['avg < 2000'],
    },
    scenarios: {
        // In each SCRAPE_INTERVAL_SECONDS, WRITE_REQUEST_RATE number of remote-write requests will be made.
        writing_metrics: {
            executor: 'ramping-arrival-rate',
            timeUnit: `${SCRAPE_INTERVAL_SECONDS}s`,

            // The number of VUs should be adjusted based on how much load we're pushing on the write path.
            // We estimated about 1 VU every 8.5k series.
            preAllocatedVUs: Math.ceil(TOTAL_SERIES / 8500),
            maxVus: Math.ceil(TOTAL_SERIES / 8500),
            exec: 'write',

            stages: [
                {
                    // Ramp up over a period of RAMP_UP_MIN to the target rate.
                    target: (WRITE_REQUEST_RATE * HA_REPLICAS), duration: `0m`,
                }, {
                    target: (WRITE_REQUEST_RATE * HA_REPLICAS), duration: `${DURATION_MIN - RAMP_DOWN_MIN}m`,
                }, {
                    // Ramp back down over a period of RAMP_DOWN_MIN to a rate of 0.
                    target: 0, duration: `${RAMP_DOWN_MIN}m`,
                },
            ]
        },
        read_instant_queries: {
            executor: 'constant-arrival-rate',
            // 10 request per second
            rate: READ_REQUEST_RATE,
            timeUnit: '1s',

            duration: `${DURATION_MIN}m`,
            exec: 'read',

            // The number of VUs should be adjusted based on how much load we're pushing on the read path.
            // We estimated about 5 VU every query/sec.
            preAllocatedVUs: READ_REQUEST_RATE*5,
            maxVus: READ_REQUEST_RATE*5,
        },
    },
};

/**
 * Generates and writes series, checking the results.
 * Requests are tagged with { type: "write" } so that they can be distinguished from queries.
 */
const names = [
    'windows_system_system_up_time', 
];
export function write() {
    try {
        const nameIndex = Math.floor(Math.random() * 10);
        const name = names[0]; // + "_" + Math.floor(Math.random() * 6);
        // iteration only advances after every second test iteration,
        // because we want to send every series twice to simulate HA pairs.
        const iteration = Math.floor(exec.scenario.iterationInTest / HA_REPLICAS);

        // ha_replica indicates which ha replica is sending this request (simulated).
        const ha_replica = exec.scenario.iterationInTest % HA_REPLICAS;

        // ha_cluster is the id of the ha cluster sending this request (simulated).
        // const ha_cluster = iteration % HA_CLUSTERS;

        // min_series_id is calculated based on the current iteration number.
        // It is used to define which batch of the total set of series which we're going to generate will be sent in this request.
        const min_series_id = (iteration % (TOTAL_SERIES / WRITE_SERIES_PER_REQUEST)) * WRITE_SERIES_PER_REQUEST;
        const max_series_id = min_series_id + WRITE_SERIES_PER_REQUEST;
        const now_ms = Date.now();
        const now_s = Math.floor(now_ms/1000);

        const res = write_client.storeFromTemplates(
            // We're using the timestamp in seconds as a value because counters are very common in Prometheus and
            // counters usually are a number that increases over time, by using the timestamp in seconds we
            // hope to achieve a similar compression ratio as counters do.
            now_s,                                                 // Minimum of randomly chosen sample value.
            now_s,                                                 // Maximum of randomly chosen sample value.

            now_ms,                                                // Time associated with generated samples.
            min_series_id,                                         // Minimum series ID.
            max_series_id,                                         // Maximum series ID.

            // Beginning of label/value templates.
            {
                __name__: name, // Name of the series.
                // everytime the label is different
                agent_hostname: 'host${series_id%2500}',  // Each value of this label will match 1 series.
                __replica__: `replica_${ha_replica}`,              // Name of the ha replica sending this.
                agent_data: '${series_id}',
            }
        );
        console.log('the min series id is: host', min_series_id);
        console.log('the max series id is: host',max_series_id);

        check(res, {
            'write worked': (r) => r.status === 200 || r.status === 202,
        }, { type: "write" }) || fail(`ERR: write failed. Status: ${res.status}. Body: ${res.body}`);
    }
    catch (e) {
        check(null, {
            'write worked': () => false,
        }, { type: "write" });
        throw e;
    }
}

export function read() {
    try {
        const time = Math.ceil(Date.now() / 1000) - 60;
        const query = generateQuery();
        console.log(query)
        const res = query_client.post('/query', {
            query: query,
            time: time,
        });

        check(res, {
            'read worked': (r) => r.status === 200 && r.json('status') === "success" && r.json('data.resultType') === "vector",
        }, { type: "read" }) || fail(`ERR: read failed. Status: ${res.status}. Body: ${res.body}`);
    }
    catch (e) {
        check(null, {
            'read worked': () => false,
        }, { type: "read" });
        throw e;
    }
}
function generateQuery() {
    const rateQuery = Math.random();
    if (rateQuery < 0.5) {
        return "(" + singleQuery() + "-" + singleQuery() + ")/(1024*1024)"; 
    }else if (rateQuery < 0.8) {
        const sin = singleQuery();
        const constinterval = Math.floor(Math.random() * 10) + 1;
        return `rate(${sin}[${constinterval}m]) * 1000`;
    }
    return singleQuery();
}

function singleQuery() {
    let useReg = Math.random() < 0.5;
    const nameIndex = Math.floor(Math.random() * 6);
    const metricsName = names[0]; // + "_" + Math.floor(Math.random() * 10);
    const removeIndex = Math.floor(Math.random() * READ_SERIES_PER_REQUEST);
    const hostNames = combineHosts(0, removeIndex) + '|' + combineHosts(removeIndex + 1, READ_SERIES_PER_REQUEST+1);
    const query = useReg?`${metricsName}{agent_hostname=~\"${hostNames}\", agent_data!~\"${nameIndex}.*\"}`:`${metricsName}{agent_hostname=~\"${hostNames}\"}`;
    return query;
}

function combineHosts(start, end) {
    let combinedHosts = '';
    
    for (let i = start; i < end; i++) {
        const flag1 = Math.random() < 0.5;
        const flag2 = Math.random() < 0.7;
        combinedHosts = flag2? (flag1 ? 'host' + i + '|' + combinedHosts : combinedHosts + 'host' + i + '|') : combinedHosts;
    }
    // Remove the trailing pipe symbol
    if (combinedHosts.endsWith('|')) {
        combinedHosts = combinedHosts.slice(0, -1);
    }
    
    return combinedHosts;
  }

/**
 * Returns the write URL.
 * @returns {string}
 */
function get_remote_write_url() {
    if (USERNAME !== '' || WRITE_TOKEN !== '') {
        return `${SCHEME}://${WRITE_HOSTNAME}/api/v1/push`;
    }

    return `${SCHEME}://${WRITE_HOSTNAME}/api/v1/push`;
}

/**
 * Returns the HTTP Authentication header to use on the read path.
 * @returns {map}
 */
function get_read_authentication_headers() {
    let auth_headers = new Map();
    
    if (USERNAME !== '' || READ_TOKEN !== '') {
        auth_headers.set('Authorization', `Basic ${encoding.b64encode(`${USERNAME}:${READ_TOKEN}`)}`)
    }
    
    if (TENANT_ID !== '') {
        auth_headers.set('X-Scope-OrgID', TENANT_ID)
    }
    
    return auth_headers;
}