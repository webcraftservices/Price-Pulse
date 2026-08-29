/**
 * PricePulse API Layer — connects to real backend server
 */

const API_BASE = "http://localhost:5000";

const PricePulseAPI = {
  async _fetch(endpoint, body) {
    console.log("FETCH START");
console.log("Endpoint:", endpoint);
console.log("Body:", body);
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Something went wrong. Please try again.');
    }
    return data;
  },

  async comparePrices(url) {

    console.log("comparePrices() entered");

    console.log("Sending URL:", url);

    const result = await this._fetch("/api/compare", { url });

    console.log("Received result:", result);

    return result;
},

  async compareByText(query) {
    console.log("compareByText() entered", query);
    const result = await this._fetch("/api/compare-text", { query });
    console.log("Received result:", result);
    return result;
},

  async compareByProduct(product) {
    console.log("compareByProduct() entered", product);
    const result = await this._fetch("/api/compare-text", { product });
    console.log("Received result:", result);
    return result;
},

  async searchByImage(imageFile) {
    console.log("API function entered");

    const formData = new FormData();
    formData.append("image", imageFile);

    console.log("Before fetch");

    // Hang protection: never let AI Find spin forever if the backend/Gemini
    // never responds. 45s comfortably covers a real Gemini vision call.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    let res;
    try {
      res = await fetch(`${API_BASE}/api/search-image`, {
          method: "POST",
          body: formData,
          signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error("This is taking longer than expected. Please try again.");
      }
      throw new Error("Couldn't reach the AI Find service right now. Please try again in a moment.");
    } finally {
      clearTimeout(timeoutId);
    }

    console.log("After fetch");

    const text = await res.text();
    console.log("Response:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Got an unexpected response from the AI Find service. Please try again.");
    }

    // A non-2xx response (upload failure, Gemini failure, unidentifiable
    // product, etc.) must surface as an error — never be treated as a found
    // result just because the request technically completed.
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Couldn't identify a product in that photo. Please try again.");
    }

    return data;
},

  getSpendData(connectedPlatforms) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

    function hashString(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    }

    const data = months.map((month) => {
      let total = 0;
      connectedPlatforms.forEach(p => {
        total += 2000 + (hashString(p + month) % 8000);
      });
      return { month, amount: total };
    });

    const transactions = [];
    const items = [
      'Wireless Earbuds', 'Running Shoes', 'Phone Case', 'Skincare Set',
      'Books (3)', 'Kitchen Appliance', 'T-Shirt Pack', 'USB-C Cable',
    ];

    connectedPlatforms.forEach(platform => {
      const count = 2 + (hashString(platform) % 3);
      for (let i = 0; i < count; i++) {
        const day = 1 + (hashString(platform + i) % 28);
        const month = 1 + (hashString(platform + i + 'm') % 6);
        transactions.push({
          platform: platform.charAt(0).toUpperCase() + platform.slice(1),
          platformId: platform,
          item: items[(hashString(platform + i) % items.length)],
          amount: 500 + (hashString(platform + i + 'a') % 9500),
          date: `${day} ${months[month - 1]} 2026`,
        });
      }
    });

    transactions.sort((a, b) => b.amount - a.amount);

    return {
      chartData: data,
      transactions: transactions.slice(0, 8),
      totalSpend: data.reduce((s, d) => s + d.amount, 0),
      monthSpend: data[data.length - 1].amount,
    };
  },
};

window.PricePulseAPI = PricePulseAPI;
