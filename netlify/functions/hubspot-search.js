// Netlify serverless function (classic "v1" handler format — the most
// broadly compatible format for drag-and-drop deploys).
// The HubSpot token stays on the server (Netlify environment variable) —
// it is never sent to the browser.
//
// Called as: GET /.netlify/functions/hubspot-search?q=some+company+name

const HUBSPOT_BASE = "https://api.hubapi.com";

async function hubspotFetch(path, token, options = {}) {
  const res = await fetch(HUBSPOT_BASE + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("HubSpot " + path + " failed: " + res.status + " " + body.slice(0, 300));
  }
  return res.json();
}

let cachedCodeProperty;
async function findCodePropertyName(token) {
  if (cachedCodeProperty !== undefined) return cachedCodeProperty;
  try {
    const data = await hubspotFetch("/crm/v3/properties/companies", token);
    const candidates = ["customer_code", "account_code", "erp_code", "customer_id", "client_code"];
    const byName = new Set((data.results || []).map((p) => p.name));
    let found = candidates.find((c) => byName.has(c));
    if (!found) {
      const fuzzy = (data.results || []).find(
        (p) => /code/i.test(p.label || "") && /custom|account|customer|client|erp/i.test(p.label || "")
      );
      found = fuzzy ? fuzzy.name : null;
    }
    cachedCodeProperty = found || null;
  } catch {
    cachedCodeProperty = null;
  }
  return cachedCodeProperty;
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "HUBSPOT_TOKEN is not set on the server." }),
    };
  }

  const q = ((event.queryStringParameters && event.queryStringParameters.q) || "").trim();
  if (!q) {
    return { statusCode: 200, headers, body: JSON.stringify({ results: [] }) };
  }

  try {
    const codeProp = await findCodePropertyName(token);
    const companyProps = ["name", "address", "city", "zip", "phone", "domain"];
    if (codeProp) companyProps.push(codeProp);

    const searchBody = {
      filterGroups: [
        { filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: q }] },
      ],
      properties: companyProps,
      limit: 5,
    };
    const companyData = await hubspotFetch(
      "/crm/v3/objects/companies/search",
      token,
      { method: "POST", body: JSON.stringify(searchBody) }
    );

    const companies = companyData.results || [];

    const results = await Promise.all(
      companies.map(async (co) => {
        const p = co.properties || {};
        const address = [p.address, p.city, p.zip].filter(Boolean).join(", ");
        let contactName = "", contactPhone = "", contactEmail = "";

        try {
          const assoc = await hubspotFetch(
            "/crm/v4/objects/companies/" + co.id + "/associations/contacts",
            token
          );
          const contactId = assoc.results && assoc.results[0] && assoc.results[0].toObjectId;
          if (contactId) {
            const contact = await hubspotFetch(
              "/crm/v3/objects/contacts/" + contactId + "?properties=firstname,lastname,phone,email",
              token
            );
            const cp = contact.properties || {};
            contactName = [cp.firstname, cp.lastname].filter(Boolean).join(" ");
            contactPhone = cp.phone || "";
            contactEmail = cp.email || "";
          }
        } catch {
          // no contact found — leave contact fields blank
        }

        return {
          companyName: p.name || "",
          customerCode: codeProp ? p[codeProp] || "" : "",
          address,
          phone: p.phone || "",
          email: "",
          contactName,
          contactPhone,
          contactEmail,
        };
      })
    );

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: String(err && err.message ? err.message : err) }),
    };
  }
};
