// Imported only by the isolated admin integration test, never npm start.
import pg from 'pg';
if(process.env.NODE_ENV!=='test') throw new Error('Admin fault injection requires NODE_ENV=test');
const query=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,values,...rest){
  const sql=typeof config==='string'?config:config?.text;
  if(sql?.includes('INSERT INTO letchat_moderation_log') && values?.some(v=>typeof v==='string'&&v.includes('TEST-ADMIN-FAIL')))
    return Promise.reject(new Error('Isolated audit write failure'));
  return query.call(this,config,values,...rest);
};
