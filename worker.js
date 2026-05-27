export default {
  async fetch(request, env, ctx) {

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const AIRTABLE_TOKEN = env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = env.AIRTABLE_BASE;
    const AIRTABLE_TABLE = env.AIRTABLE_TABLE;
    const GEELARK_APP_ID = env.GEELARK_APP_ID;
    const GEELARK_API_KEY = env.GEELARK_API_KEY;
    const WORKER_SECRET = env.WORKER_SECRET;

    if (request.method === 'GET') {
      const clientSecret = url.searchParams.get('secret');
      if (clientSecret !== WORKER_SECRET) {
        return new Response(JSON.stringify({ error: 'Non autorisé' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_KEY;

    const PLAN_LIMITS = { starter: 3, pro: 10, agency: Infinity };

    async function checkPlanLimit(userId) {
      if (!userId) return { allowed: false, reason: 'Non connecté' };

      const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${userId}&select=plan,accounts_used,email`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      const data = await res.json();
      if (!data || data.length === 0) return { allowed: false, reason: 'Profil introuvable' };

      const profile = data[0];
      const plan = profile.plan || 'starter';
      const used = profile.accounts_used || 0;
      const limit = PLAN_LIMITS[plan] || 3;

      if (used >= limit) {
        return { allowed: false, reason: `Limite atteinte (${used}/${limit} comptes) — passez au plan supérieur`, plan, used, limit };
      }
      return { allowed: true, plan, used, limit };
    }

    async function incrementAccountsUsed(userId) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${userId}&select=accounts_used,email`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const data = await res.json();
        const current = data[0]?.accounts_used || 0;

        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ accounts_used: current + 1 })
        });
        const patchData = await patchRes.json();
        return { success: true, current, new: current + 1, patchData };
      } catch(e) {
        return { success: false, error: e.message };
      }
    }

    async function getGeelarkHeaders() {
      const traceId = crypto.randomUUID();
      const ts = Date.now().toString();
      const nonce = traceId.substring(0, 6);
      const signString = GEELARK_APP_ID + traceId + ts + nonce + GEELARK_API_KEY;
      const encoder = new TextEncoder();
      const data = encoder.encode(signString);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const sign = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      return {
        'Content-Type': 'application/json',
        'appId': GEELARK_APP_ID,
        'traceId': traceId,
        'ts': ts,
        'nonce': nonce,
        'sign': sign
      };
    }

    try {

      // GET /accounts?userId=xxx
      if (path === '/accounts' && request.method === 'GET') {
        const userId = url.searchParams.get('userId');
        if (!userId) {
          return new Response(JSON.stringify({ records: [] }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        const filterFormula = encodeURIComponent(`{user_id} = "${userId}"`);
        const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${filterFormula}`, {
          headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // POST /warmup
      if (path === '/warmup' && request.method === 'POST') {
        const body = await request.json();
        if (body.secret !== WORKER_SECRET) return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { profileId, recordId } = body;
        const scheduleAt = Math.floor(Date.now() / 1000) + 10;
        const headers = await getGeelarkHeaders();
        const res = await fetch('https://openapi.geelark.com/open/v1/rpa/task/instagramWarmup', {
          method: 'POST',
          headers,
          body: JSON.stringify({ scheduleAt, id: profileId })
        });
        const data = await res.json();
        const taskId = data.data ? (data.data.taskId || data.data.id || '') : '';

        if (recordId) {
          const recordRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
            headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
          });
          const recordData = await recordRes.json();
          const currentDay = parseInt(recordData.fields['Jour warmup'] || 0);

          await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              fields: {
                'task_id': taskId,
                'Derniere action': new Date().toISOString().split('T')[0],
                'Statut warmup': 'En cours',
                'Jour warmup': currentDay + 1
              }
            })
          });
        }
        return new Response(JSON.stringify({ ...data, debug: { recordId, taskId, profileId } }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // POST /add-account
      if (path === '/add-account' && request.method === 'POST') {
        const body = await request.json();
        if (body.secret !== WORKER_SECRET) return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { nom, geelarkId, plateforme, userId } = body;

        const limitCheck = await checkPlanLimit(userId);
        if (!limitCheck.allowed) {
          return new Response(JSON.stringify({ error: limitCheck.reason, limitReached: true }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const airtableBody = {
          fields: {
            'Nom du compte': nom,
            'ID Geelark': geelarkId,
            'Plateforme': plateforme || 'Instagram',
            'Statut warmup': 'En cours',
            'Jour warmup': 1,
            'user_id': userId || ''
          }
        };

        const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(airtableBody)
        });

        const responseText = await res.text();
        let data;
        try {
          data = JSON.parse(responseText);
        } catch(e) {
          return new Response(JSON.stringify({ error: 'Airtable response error', raw: responseText }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // FIX: incrémenter accounts_used après ajout réussi
        if (data.id && userId) {
          await incrementAccountsUsed(userId);
        }

        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // DELETE /delete-account
      if (path === '/delete-account' && request.method === 'POST') {
        const body = await request.json();
        if (body.secret !== WORKER_SECRET) return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { recordId } = body;

        const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
        });

        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // POST /status
      if (path === '/status' && request.method === 'POST') {
        const body = await request.json();
        if (body.secret !== WORKER_SECRET) return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { taskIds } = body;
        if (!taskIds || taskIds.length === 0) {
          return new Response(JSON.stringify({ data: { items: [] } }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        const headers = await getGeelarkHeaders();
        const res = await fetch('https://openapi.geelark.com/open/v1/task/query', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ids: taskIds })
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // GET /plan?userId=xxx
      if (path === '/plan' && request.method === 'GET') {
        const userId = url.searchParams.get('userId');
        if (!userId) return new Response(JSON.stringify({ plan: 'starter', used: 0, limit: 3 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${userId}&select=plan,accounts_used,email`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const data = await res.json();
        const profile = data[0] || {};
        const plan = profile.plan || 'starter';
        const used = profile.accounts_used || 0;
        const limit = PLAN_LIMITS[plan] || 3;
        return new Response(JSON.stringify({ plan, used, limit: limit === Infinity ? 9999 : limit }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // GET /admin-accounts — tous les comptes Airtable sans filtre
      if (path === '/admin-accounts' && request.method === 'GET') {
        const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`, {
          headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // GET /admin-users — tous les profils Supabase
      if (path === '/admin-users' && request.method === 'GET') {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=email,plan,activated,accounts_used&order=activated.desc,email.asc`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // POST /admin-update-user — modifie plan et/ou activated d'un user
      if (path === '/admin-update-user' && request.method === 'POST') {
        const body = await request.json();
        if (body.secret !== WORKER_SECRET) return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { email, plan, activated } = body;

        if (!email) return new Response(JSON.stringify({ error: 'Email requis' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const updates = {};
        if (plan !== undefined) updates.plan = plan;
        if (activated !== undefined) updates.activated = activated;

        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(updates)
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('WarmupOS API v4', { headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
