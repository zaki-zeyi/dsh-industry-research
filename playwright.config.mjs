import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e', fullyParallel:false, workers:1, timeout:30000,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:3099',headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}),trace:'retain-on-failure',screenshot:'only-on-failure',viewport:{width:1440,height:1000}},
  webServer:{command:'node scripts/e2e-server.mjs',url:'http://127.0.0.1:3099/api/health',reuseExistingServer:false,timeout:20000},
});
