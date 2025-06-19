require('dotenv').config();
const axios = require('axios');
const twilio = require('twilio');
const cron = require('node-cron');

// Configuration
const CONFIG = {
  location: { lat: 30.1588, lon: -95.4892 }, // The Woodlands, TX coordinates
  phoneNumbers: ['8577013958', '6176426481'],
  timeWindow: { start: 14, end: 19 }, // 2pm - 7pm (24hr format)
  requiredSunnyHours: 2,
  message: "Pool Time!!!! It's sunny out, you don't want to miss out!"
};

// Weather API functions
async function getWeatherData() {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) {
    throw new Error('WEATHER_API_KEY not found in environment variables');
  }

  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${CONFIG.location.lat}&lon=${CONFIG.location.lon}&appid=${apiKey}&units=imperial`;
  
  try {
    const response = await axios.get(url);
    return response.data.list;
  } catch (error) {
    console.error('Error fetching weather data:', error.message);
    throw error;
  }
}

function isSunny(weatherData) {
  // OpenWeatherMap weather conditions
  // Clear sky: 800, Few clouds: 801
  const sunnyConditions = [800, 801];
  return sunnyConditions.includes(weatherData.weather[0].id);
}

function checkConsecutiveSunnyHours(weatherList) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format
  
  // Filter for today's forecasts within time window
  const todayForecasts = weatherList.filter(forecast => {
    const forecastDate = new Date(forecast.dt * 1000);
    const forecastHour = forecastDate.getHours();
    const forecastDateStr = forecastDate.toISOString().split('T')[0];
    
    return forecastDateStr === todayStr && 
           forecastHour >= CONFIG.timeWindow.start && 
           forecastHour < CONFIG.timeWindow.end;
  });

  if (todayForecasts.length === 0) return false;

  // Check for consecutive sunny hours
  let consecutiveSunnyCount = 0;
  let maxConsecutive = 0;

  for (const forecast of todayForecasts) {
    if (isSunny(forecast)) {
      consecutiveSunnyCount++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveSunnyCount);
    } else {
      consecutiveSunnyCount = 0;
    }
  }

  console.log(`Found ${maxConsecutive} consecutive sunny hours today`);
  return maxConsecutive >= CONFIG.requiredSunnyHours;
}

async function sendSMSNotifications() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio credentials not found in environment variables');
  }

  const client = twilio(accountSid, authToken);
  const results = [];

  for (const phoneNumber of CONFIG.phoneNumbers) {
    try {
      const message = await client.messages.create({
        body: CONFIG.message,
        from: fromNumber,
        to: `+1${phoneNumber}`
      });
      console.log(`SMS sent to ${phoneNumber}: ${message.sid}`);
      results.push({ phoneNumber, success: true, sid: message.sid });
    } catch (error) {
      console.error(`Failed to send SMS to ${phoneNumber}:`, error.message);
      results.push({ phoneNumber, success: false, error: error.message });
    }
  }

  return results;
}

async function checkWeatherAndNotify() {
  try {
    console.log('Checking weather conditions...');
    const weatherData = await getWeatherData();
    
    if (checkConsecutiveSunnyHours(weatherData)) {
      console.log('Pool time conditions met! Sending notifications...');
      const smsResults = await sendSMSNotifications();
      const successCount = smsResults.filter(r => r.success).length;
      console.log(`Successfully sent ${successCount} of ${smsResults.length} SMS notifications`);
      return true;
    } else {
      console.log('Not enough consecutive sunny hours for pool time');
      return false;
    }
  } catch (error) {
    console.error('Error checking weather:', error.message);
    return false;
  }
}

// Track if we've already sent notification today to avoid spamming
let notificationSentToday = false;
let lastNotificationDate = '';

function resetDailyNotification() {
  const today = new Date().toISOString().split('T')[0];
  if (lastNotificationDate !== today) {
    notificationSentToday = false;
    lastNotificationDate = today;
  }
}

function logWithTimestamp(message) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] ${message}`);
}

async function scheduledWeatherCheck() {
  try {
    resetDailyNotification();
    
    if (notificationSentToday) {
      logWithTimestamp('Notification already sent today, skipping check');
      return;
    }

    logWithTimestamp('Starting scheduled weather check...');
    const result = await checkWeatherAndNotify();
    if (result) {
      notificationSentToday = true;
      logWithTimestamp('Pool time notification sent successfully');
    }
  } catch (error) {
    logWithTimestamp(`Error in scheduled weather check: ${error.message}`);
  }
}

logWithTimestamp('Pool Time Weather Notification App starting...');
logWithTimestamp(`Monitoring weather for: The Woodlands, TX`);
logWithTimestamp(`Checking for ${CONFIG.requiredSunnyHours} consecutive sunny hours between ${CONFIG.timeWindow.start}:00 - ${CONFIG.timeWindow.end}:00`);

// Schedule weather checks every hour from 1pm to 6pm
cron.schedule('0 13-18 * * *', scheduledWeatherCheck);
logWithTimestamp('Scheduled hourly weather checks from 1pm to 6pm');

// Handle process termination gracefully
process.on('SIGINT', () => {
  logWithTimestamp('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logWithTimestamp('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Run an initial check
logWithTimestamp('Running initial weather check...');
scheduledWeatherCheck();