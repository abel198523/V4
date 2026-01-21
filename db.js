require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

// የዳታቤዝ ግንኙነቱን መፈተሻ
pool.connect((err, client, release) => {
    if (err) {
        return console.error('ዳታቤዙ ጋር መገናኘት አልተቻለም፡', err.stack);
    }
    console.log('ከ Neon PostgreSQL ጋር በተሳካ ሁኔታ ተገናኝቷል!');
    release();
});

module.exports = {
    /**
     * ለሁሉም የዳታቤዝ ጥያቄዎች (Queries) የምንጠቀመው ፈንክሽን
     * @param {string} text - የ SQL ኮድ
     * @param {Array} params - ለ SQL ኮዱ የሚላኩ መረጃዎች
     */
    query: (text, params) => pool.query(text, params),
    
    // አስፈላጊ ከሆነ ፑሉን በቀጥታ ለመጠቀም
    pool: pool 
};