// pm2 ecosystem config — ONE place that answers "how does the bot restart".
//
// The bot restarts itself three ways, all configured here:
//   1. Crash  -> pm2 restarts it automatically when it dies.
//   2. Boot   -> pm2 startup re-registers it on Windows login/reboot.
//   3. Edits  -> --watch reloads it whenever source or config files change.
//
// Why these settings:
//   max_restarts + restart_delay: pm2's default is 15 restarts in 15s, which
//   a flapping startup (bad RPC endpoint, missing env) burns through in
//   seconds and then the bot stays DEAD. Being generous here means a network
//   blip at boot does not take the bot out for the day.
//
//   min_uptime: pm2 treats a process that stays up this long as "stable" and
//   resets the restart counter. Without it every crash is treated as a fresh
//   flutter and the bot can hit max_restarts on a run that was fine for hours.
//
//   The watch allow/ignore split matters more than it looks: data/ churns
//   constantly (bot.sqlite, armedMints.json, nftHoldings.json written by the
//   bot itself). Watching data/ turns every write into a self-restart loop.
//   .env holds secrets but changing it SHOULD restart the bot so the new
//   value takes effect, so it is an explicit watch target.
module.exports = {
  apps: [
    {
      name: "nftbot",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      min_uptime: "30s",
      watch: true,
      watch_delay: 1000,
      watch_options: {
        followSymlinks: false,
      },
      ignore_watch: [
        "node_modules",
        "data",
        ".git",
        "logs",
        "*.log",
        "tests",
        "contracts",
        "assets",
      ],
      watch_environment: true,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
