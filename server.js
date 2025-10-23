const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration from environment variables
const CONFIG = {
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  MIN_BET_AMOUNT: parseFloat(process.env.MIN_BET_AMOUNT) || 10000,
  NEW_ACCOUNT_DAYS: parseInt(process.env.NEW_ACCOUNT_DAYS) || 7,
  PRE_EVENT_ALERT_MINUTES: parseInt(process.env.PRE_EVENT_ALERT_MINUTES) || 60,
  PRE_CLOSE_ALERT_MINUTES: parseInt(process.env.PRE_CLOSE_ALERT_MINUTES) || 60,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 30000,
  HIGH_RISK_CATEGORIES: (process.env.HIGH_RISK_CATEGORIES || 'economics,congress,politics,fed,earnings').split(','),
};

// In-memory stores to prevent duplicate alerts
const alertedTrades = new Set();
const lastProcessedTime = new Map(); // Track last time we processed each market
const MAX_STORED_ALERTS = 5000;

// Kalshi API configuration
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_DEMO_API = 'https://demo-api.kalshi.co/trade-api/v2';

// Use demo API for testing, production API for live
const API_BASE = process.env.KALSHI_USE_DEMO === 'true' ? KALSHI_DEMO_API : KALSHI_API;

let startTime = null; // Track when monitoring started

console.log('🚀 Kalshi Timing-Based Insider Trading Tracker');
console.log('⚙️  Min bet amount: $' + CONFIG.MIN_BET_AMOUNT.toLocaleString());
console.log('⏱️  New account threshold: ' + CONFIG.NEW_ACCOUNT_DAYS + ' days');
console.log('⏰ Pre-event alert window: ' + CONFIG.PRE_EVENT_ALERT_MINUTES + ' minutes');
console.log('🔔 Discord alerts: ' + (CONFIG.DISCORD_WEBHOOK ? '✅ ENABLED' : '❌ DISABLED'));

/**
 * Initialize start time - only monitor trades after this point
 */
function initializeStartTime() {
  startTime = new Date();
  console.log('📅 Monitoring start time: ' + startTime.toISOString());
  console.log('⚠️  Only trades AFTER this time will be tracked (no historical data)');
}

/**
 * Fetch active markets from Kalshi
 */
async function getActiveMarkets() {
  try {
    const response = await axios.get(`${API_BASE}/markets`, {
      params: {
        limit: 200,
        status: 'open'
      },
      timeout: 15000
    });
    
    return response.data?.markets || [];
  } catch (error) {
    console.error('⚠️  Error fetching markets:', error.message);
    return [];
  }
}

/**
 * Get trades for a specific market
 */
async function getMarketTrades(marketTicker, limit = 50) {
  try {
    const response = await axios.get(`${API_BASE}/markets/${marketTicker}/trades`, {
      params: {
        limit: limit
      },
      timeout: 10000
    });
    
    return response.data?.trades || [];
  } catch (error) {
    console.error(`⚠️  Error fetching trades for ${marketTicker}:`, error.message);
    return [];
  }
}

/**
 * Calculate time until event in minutes
 */
function getMinutesUntilEvent(eventTime) {
  const now = new Date();
  const event = new Date(eventTime);
  const diffMs = event - now;
  return Math.floor(diffMs / (1000 * 60));
}

/**
 * Calculate time until market close in minutes
 */
function getMinutesUntilClose(closeTime) {
  const now = new Date();
  const close = new Date(closeTime);
  const diffMs = close - now;
  return Math.floor(diffMs / (1000 * 60));
}

/**
 * Check if market is in high-risk category
 */
function isHighRiskCategory(market) {
  const category = (market.category || '').toLowerCase();
  const title = (market.title || '').toLowerCase();
  
  for (const riskCat of CONFIG.HIGH_RISK_CATEGORIES) {
    if (category.includes(riskCat) || title.includes(riskCat)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse trade timestamp and check if it's after our start time
 */
function isTradeAfterStartTime(tradeTime) {
  if (!startTime) return true;
  
  const tradeDate = new Date(tradeTime);
  return tradeDate > startTime;
}

/**
 * Estimate account age (Kalshi doesn't provide this directly)
 * This is a placeholder - in production, you'd need to track users separately
 */
function checkAccountAge(userId) {
  // Note: Kalshi API doesn't expose account creation dates
  // For production, you'd need to:
  // 1. Maintain a database of first-seen users
  // 2. Or use Kalshi's member-since data if available
  // For now, we'll flag all as potentially new for demonstration
  
  return {
    isNew: true, // Conservative approach: assume could be new
    description: '⚠️ Account age unknown (Kalshi API limitation)',
    daysSinceCreation: 0
  };
}

/**
 * Send Discord alert for suspicious timing
 */
async function sendTimingAlert(market, trade, timingInfo) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    console.log('⚠️  Discord webhook not configured, skipping alert');
    return;
  }

  try {
    const marketUrl = `https://kalshi.com/markets/${market.ticker}`;
    
    // Determine alert color based on timing severity
    let color = 0xFFAA00; // Orange default
    let riskLevel = 'MEDIUM';
    
    if (timingInfo.minutesUntil <= 15) {
      color = 0xFF0000; // Red for critical
      riskLevel = 'CRITICAL';
    } else if (timingInfo.minutesUntil <= 30) {
      color = 0xFF6600; // Dark orange for high
      riskLevel = 'HIGH';
    }

    // Format timing message
    let timingMessage = '';
    if (timingInfo.type === 'pre-event') {
      timingMessage = `⚠️ ${timingInfo.minutesUntil} MINUTES BEFORE ${timingInfo.eventType}`;
    } else if (timingInfo.type === 'pre-close') {
      timingMessage = `⚠️ ${timingInfo.minutesUntil} MINUTES BEFORE MARKET CLOSES`;
    }

    const embed = {
      title: '🚨 SUSPICIOUS TIMING DETECTED - KALSHI',
      description: 'Large bet from potentially new account with suspicious timing!',
      color: color,
      fields: [
        {
          name: '📊 Market',
          value: market.title || market.ticker,
          inline: false
        },
        {
          name: '⏰ Timing',
          value: timingMessage,
          inline: false
        },
        {
          name: '💰 Trade Amount',
          value: `$${(trade.count * (trade.yes_price || trade.no_price || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          inline: true
        },
        {
          name: '🎯 Position',
          value: trade.side === 'yes' ? 'YES ✅' : 'NO ❌',
          inline: true
        },
        {
          name: '📅 Event Time',
          value: timingInfo.eventTime ? new Date(timingInfo.eventTime).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'N/A',
          inline: false
        },
        {
          name: '⏱️ Trade Time',
          value: new Date(trade.created_time).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET',
          inline: false
        },
        {
          name: '📂 Category',
          value: market.category || 'Unknown',
          inline: true
        },
        {
          name: '⚡ Risk Level',
          value: riskLevel,
          inline: true
        },
        {
          name: '🔗 Market Link',
          value: `[View on Kalshi](${marketUrl})`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Kalshi Timing-Based Insider Trading Tracker'
      }
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK, {
      embeds: [embed]
    });

    console.log('✅ Alert sent to Discord');
  } catch (error) {
    console.error('❌ Error sending Discord alert:', error.message);
  }
}

/**
 * Main monitoring function
 */
async function monitorMarkets() {
  console.log('🔍 Checking for suspicious timing patterns...');

  try {
    const markets = await getActiveMarkets();
    console.log(`📊 Found ${markets.length} active markets`);

    let alertsSent = 0;
    let marketsChecked = 0;

    for (const market of markets) {
      try {
        // Skip if market is closed or doesn't have proper data
        if (market.status !== 'open') {
          continue;
        }

        const eventTime = market.expected_expiration_time || market.close_time;
        if (!eventTime) {
          continue;
        }

        // Calculate time until event
        const minutesUntilEvent = getMinutesUntilEvent(eventTime);
        
        // Skip if event is too far away or already passed
        if (minutesUntilEvent < 0 || minutesUntilEvent > 1440) { // 24 hours
          continue;
        }

        marketsChecked++;

        // Only check markets that are approaching their event time
        const shouldCheck = minutesUntilEvent <= CONFIG.PRE_EVENT_ALERT_MINUTES * 2; // Check if within 2x alert window
        
        if (!shouldCheck) {
          continue;
        }

        // Get recent trades
        const trades = await getMarketTrades(market.ticker, 20);
        
        for (const trade of trades) {
          try {
            // Skip if no timestamp
            if (!trade.created_time) continue;

            // CRITICAL: Skip historical trades (before monitoring started)
            if (!isTradeAfterStartTime(trade.created_time)) {
              continue;
            }

            // Calculate trade amount in dollars
            const priceInCents = trade.yes_price || trade.no_price || 0;
            const tradeAmount = (trade.count * priceInCents) / 100;

            // Skip if below minimum
            if (tradeAmount < CONFIG.MIN_BET_AMOUNT) {
              continue;
            }

            // Create unique alert key to prevent duplicates
            const tradeDate = new Date(trade.created_time).toISOString().split('T')[0];
            const roundedAmount = Math.floor(tradeAmount / 100) * 100;
            const alertKey = `${market.ticker}-${trade.taker_id}-${roundedAmount}-${tradeDate}-${trade.side}`;

            // Check if already alerted
            if (alertedTrades.has(alertKey)) {
              continue;
            }

            // Calculate timing
            const tradeTime = new Date(trade.created_time);
            const eventTimeDate = new Date(eventTime);
            const minutesBeforeEvent = Math.floor((eventTimeDate - tradeTime) / (1000 * 60));

            // Check if timing is suspicious (trade was made close to event)
            const isSuspiciousTiming = minutesBeforeEvent > 0 && minutesBeforeEvent <= CONFIG.PRE_EVENT_ALERT_MINUTES;

            if (!isSuspiciousTiming) {
              continue;
            }

            console.log(`🚨 SUSPICIOUS TIMING: $${tradeAmount.toLocaleString()} on ${market.ticker} - ${minutesBeforeEvent} min before event`);

            // Prepare timing info
            const timingInfo = {
              type: 'pre-event',
              minutesUntil: minutesBeforeEvent,
              eventTime: eventTime,
              eventType: 'EVENT'
            };

            // Send alert
            await sendTimingAlert(market, trade, timingInfo);

            // Mark as alerted
            alertedTrades.add(alertKey);
            alertsSent++;

            // Prevent memory leak
            if (alertedTrades.size > MAX_STORED_ALERTS) {
              const firstItem = alertedTrades.values().next().value;
              alertedTrades.delete(firstItem);
            }

            // Rate limit protection
            await new Promise(resolve => setTimeout(resolve, 2000));

          } catch (tradeError) {
            console.error(`⚠️  Error processing trade:`, tradeError.message);
          }
        }

        // Small delay between markets
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (marketError) {
        console.error(`⚠️  Error processing market:`, marketError.message);
      }
    }

    console.log(`✅ Scan complete - Checked ${marketsChecked} markets, sent ${alertsSent} alerts`);

  } catch (error) {
    console.error('❌ Error in monitoring loop:', error.message);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    startTime: startTime ? startTime.toISOString() : null,
    config: {
      minBetAmount: CONFIG.MIN_BET_AMOUNT,
      newAccountDays: CONFIG.NEW_ACCOUNT_DAYS,
      preEventMinutes: CONFIG.PRE_EVENT_ALERT_MINUTES,
      discordEnabled: !!CONFIG.DISCORD_WEBHOOK
    },
    stats: {
      alertsTracked: alertedTrades.size
    }
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    running: true,
    alertsTracked: alertedTrades.size,
    uptime: Math.floor(process.uptime()),
    monitoringSince: startTime ? startTime.toISOString() : null
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  
  // Initialize start time
  initializeStartTime();
  
  console.log('⏱️  Waiting 30 seconds before first scan...');
  console.log('⏱️  This ensures we only catch NEW trades going forward');
  
  // Wait 30 seconds, then start monitoring
  setTimeout(() => {
    console.log('🎯 Starting Kalshi timing-based monitoring...');
    
    // Run initial scan
    monitorMarkets();
    
    // Set up recurring scans
    setInterval(monitorMarkets, CONFIG.CHECK_INTERVAL);
  }, 30000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
