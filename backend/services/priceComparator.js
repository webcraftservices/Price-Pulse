/**
 * Price Comparator — backward-compatible shim
 * ------------------------------------------------------------------
 * Ranking logic now lives in comparison/offerRanker.js. This file
 * re-exports the same names compareService.js already imports from
 * "./priceComparator", so no caller needs to change. See
 * comparison/offerRanker.js for full behavior documentation.
 */

module.exports = require("../comparison/offerRanker");
