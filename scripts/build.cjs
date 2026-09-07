const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'public');
fs.mkdirSync(output,{recursive:true});
fs.mkdirSync(path.join(output,'vendor'),{recursive:true});
for(const name of ['index.html','ticket.html','app.js','ticket.js','styles.css','config.js']) fs.copyFileSync(path.join(root,name),path.join(output,name));
fs.copyFileSync(path.join(root,'vendor','fflate.min.js'),path.join(output,'vendor','fflate.min.js'));
console.log('Built 7 public assets. SQL, tests, backups and server secrets are not published.');

