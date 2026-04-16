'use strict';

// park-data.js now delegates entirely to the Rent Manager API.
// call-session.js imports buildCallerContext from here unchanged.
const rm = require('./rent-manager');

module.exports = {
  lookupTenant:          rm.lookupTenantByPhone,
  lookupTenantByName:    rm.lookupTenantByName,
  lookupTenantByLot:     rm.lookupTenantByUnit,   // "lot" = "unit" in RM
  buildAccountContext:   (tenant) => rm.buildAccountSummary(tenant, []),
  buildCallerContext:    rm.buildCallerContext,
};
