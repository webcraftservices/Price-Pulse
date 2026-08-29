const googleShopping = require("./googleShopping");
const amazon = require("./amazon");
const flipkart = require("./flipkart");

// Every adapter we know about, implemented or not — useful for reporting
// which stores are "supported" vs "pending an official API".
const ALL_ADAPTERS = [googleShopping, amazon, flipkart];

// Only adapters that return real, live data get queried during a comparison.
const ACTIVE_ADAPTERS = ALL_ADAPTERS.filter((a) => a.implemented);

module.exports = { ALL_ADAPTERS, ACTIVE_ADAPTERS };
