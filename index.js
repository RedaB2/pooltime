require('dotenv').config();
const axios = require('axios');
const twilio = require('twilio');
const cron = require('node-cron');

// Enhanced logging with timestamps
function logWithTimestamp(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// Configuration
const CONFIG = {
  location: { lat: 30.1588, lon: -95.4892 }, // The Woodlands, TX coordinates
  phoneNumbers: ['8577013958', '6176426481'],
  timeWindow: { start: 14, end: 19 }, // 2pm - 7pm (24hr format)
  requiredSunnyHours: 2,
  message: "Pool Time!!!! It's sunny out, you don't want to miss out!"
};

// Environment validation and system info logging
function validateEnvironmentAndLog() {
  logWithTimestamp('=== POOL TIME APP STARTUP ===');
  logWithTimestamp(`Node.js version: ${process.version}`);
  logWithTimestamp(`Platform: ${process.platform} ${process.arch}`);
  logWithTimestamp(`Working directory: ${process.cwd()}`);
  logWithTimestamp(`Process ID: ${process.pid}`);
  
  const memUsage = process.memoryUsage();
  logWithTimestamp(`Memory usage - RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)}MB, Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
  
  logWithTimestamp('=== CONFIGURATION VALIDATION ===');
  logWithTimestamp(`Target location: The Woodlands, TX (${CONFIG.location.lat}, ${CONFIG.location.lon})`);
  logWithTimestamp(`Time window: ${CONFIG.timeWindow.start}:00 - ${CONFIG.timeWindow.end}:00`);
  logWithTimestamp(`Required sunny hours: ${CONFIG.requiredSunnyHours}`);
  logWithTimestamp(`Phone numbers to notify: ${CONFIG.phoneNumbers.length} numbers`);
  CONFIG.phoneNumbers.forEach((num, idx) => {
    logWithTimestamp(`  Phone ${idx + 1}: ***-***-${num.slice(-4)}`);
  });
  
  logWithTimestamp('=== ENVIRONMENT VARIABLES CHECK ===');
  const requiredEnvVars = ['WEATHER_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
  const missingVars = [];
  
  requiredEnvVars.forEach(varName => {
    if (process.env[varName]) {
      const value = process.env[varName];
      const masked = value.length > 8 ? `${value.substring(0, 4)}...${value.slice(-4)}` : '***masked***';
      logWithTimestamp(`✓ ${varName}: ${masked}`);
    } else {
      logWithTimestamp(`✗ ${varName}: MISSING`, 'ERROR');
      missingVars.push(varName);
    }
  });
  
  if (missingVars.length > 0) {
    logWithTimestamp(`CRITICAL: Missing ${missingVars.length} required environment variables: ${missingVars.join(', ')}`, 'ERROR');
    return false;
  }
  
  logWithTimestamp('✓ All environment variables are configured');
  return true;
}

// Weather API functions
async function getWeatherData() {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) {
    throw new Error('WEATHER_API_KEY not found in environment variables');
  }

  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${CONFIG.location.lat}&lon=${CONFIG.location.lon}&appid=${apiKey}&units=imperial`;
  
  try {
    logWithTimestamp('Making weather API request...');
    logWithTimestamp(`API URL: ${url.replace(apiKey, '***API_KEY***')}`);
    
    const startTime = Date.now();
    const response = await axios.get(url);
    const endTime = Date.now();
    
    logWithTimestamp(`Weather API response received in ${endTime - startTime}ms`);
    logWithTimestamp(`Response status: ${response.status} ${response.statusText}`);
    logWithTimestamp(`Response size: ${JSON.stringify(response.data).length} characters`);
    
    if (response.data && response.data.list) {
      logWithTimestamp(`Weather forecast data contains ${response.data.list.length} time periods`);
      logWithTimestamp(`City: ${response.data.city.name}, ${response.data.city.country}`);
      logWithTimestamp(`Coordinates: ${response.data.city.coord.lat}, ${response.data.city.coord.lon}`);
      
      // Log sample of weather data for debugging
      const sampleForecast = response.data.list[0];
      if (sampleForecast) {
        const sampleTime = new Date(sampleForecast.dt * 1000);
        logWithTimestamp(`Sample forecast (${sampleTime.toLocaleString()}):`);
        logWithTimestamp(`  Weather: ${sampleForecast.weather[0].main} (${sampleForecast.weather[0].description})`);
        logWithTimestamp(`  Weather ID: ${sampleForecast.weather[0].id}`);
        logWithTimestamp(`  Temperature: ${sampleForecast.main.temp}°F`);
        logWithTimestamp(`  Feels like: ${sampleForecast.main.feels_like}°F`);
        logWithTimestamp(`  Humidity: ${sampleForecast.main.humidity}%`);
        logWithTimestamp(`  Cloud coverage: ${sampleForecast.clouds.all}%`);
      }
      
      return response.data.list;
    } else {
      logWithTimestamp('Warning: Weather API response missing expected data structure', 'WARN');
      return [];
    }
  } catch (error) {
    logWithTimestamp(`Error fetching weather data: ${error.message}`, 'ERROR');
    if (error.response) {
      logWithTimestamp(`API Error Status: ${error.response.status}`, 'ERROR');
      logWithTimestamp(`API Error Data: ${JSON.stringify(error.response.data)}`, 'ERROR');
    }
    if (error.code) {
      logWithTimestamp(`Error Code: ${error.code}`, 'ERROR');
    }
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
  
  logWithTimestamp(`=== ANALYZING WEATHER FOR ${todayStr} ===`);
  logWithTimestamp(`Total weather forecasts received: ${weatherList.length}`);
  
  // Filter for today's forecasts within time window
  const todayForecasts = weatherList.filter(forecast => {
    const forecastDate = new Date(forecast.dt * 1000);
    const forecastHour = forecastDate.getHours();
    const forecastDateStr = forecastDate.toISOString().split('T')[0];
    
    return forecastDateStr === todayStr && 
           forecastHour >= CONFIG.timeWindow.start && 
           forecastHour < CONFIG.timeWindow.end;
  });

  logWithTimestamp(`Forecasts for today within ${CONFIG.timeWindow.start}:00-${CONFIG.timeWindow.end}:00 window: ${todayForecasts.length}`);
  
  if (todayForecasts.length === 0) {
    logWithTimestamp('No weather forecasts found for today within the specified time window', 'WARN');
    return false;
  }

  // Log detailed forecast analysis
  todayForecasts.forEach((forecast, idx) => {
    const forecastTime = new Date(forecast.dt * 1000);
    const isSunnyResult = isSunny(forecast);
    logWithTimestamp(`  ${idx + 1}. ${forecastTime.toLocaleTimeString()} - ${forecast.weather[0].main} (ID: ${forecast.weather[0].id}) - ${isSunnyResult ? 'SUNNY ☀️' : 'NOT SUNNY ☁️'}`);
    logWithTimestamp(`     Description: ${forecast.weather[0].description}, Temp: ${forecast.main.temp}°F, Clouds: ${forecast.clouds.all}%`);
  });

  // Check for consecutive sunny hours
  let consecutiveSunnyCount = 0;
  let maxConsecutive = 0;
  let consecutiveSequences = [];
  let currentSequenceStart = null;

  for (let i = 0; i < todayForecasts.length; i++) {
    const forecast = todayForecasts[i];
    const forecastTime = new Date(forecast.dt * 1000);
    
    if (isSunny(forecast)) {
      if (consecutiveSunnyCount === 0) {
        currentSequenceStart = forecastTime.toLocaleTimeString();
      }
      consecutiveSunnyCount++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveSunnyCount);
    } else {
      if (consecutiveSunnyCount > 0) {
        const previousTime = new Date(todayForecasts[i-1].dt * 1000);
        consecutiveSequences.push({
          start: currentSequenceStart,
          end: previousTime.toLocaleTimeString(),
          hours: consecutiveSunnyCount
        });
      }
      consecutiveSunnyCount = 0;
    }
  }
  
  // Handle case where sunny period extends to end of window
  if (consecutiveSunnyCount > 0) {
    const lastTime = new Date(todayForecasts[todayForecasts.length - 1].dt * 1000);
    consecutiveSequences.push({
      start: currentSequenceStart,
      end: lastTime.toLocaleTimeString(),
      hours: consecutiveSunnyCount
    });
  }

  logWithTimestamp(`=== SUNNY PERIOD ANALYSIS ===`);
  logWithTimestamp(`Maximum consecutive sunny hours: ${maxConsecutive}`);
  logWithTimestamp(`Required consecutive sunny hours: ${CONFIG.requiredSunnyHours}`);
  
  if (consecutiveSequences.length > 0) {
    logWithTimestamp(`Sunny sequences found:`);
    consecutiveSequences.forEach((seq, idx) => {
      logWithTimestamp(`  ${idx + 1}. ${seq.start} - ${seq.end} (${seq.hours} hours)`);
    });
  } else {
    logWithTimestamp('No sunny sequences found');
  }
  
  const poolTimeReady = maxConsecutive >= CONFIG.requiredSunnyHours;
  logWithTimestamp(`Pool time conditions met: ${poolTimeReady ? 'YES ✅' : 'NO ❌'}`);
  
  return poolTimeReady;
}

async function testTwilioConnection() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio credentials not found in environment variables');
  }

  try {
    logWithTimestamp('=== TWILIO CONNECTION TEST ===');
    const client = twilio(accountSid, authToken);
    
    logWithTimestamp('Testing Twilio account access...');
    const account = await client.api.accounts(accountSid).fetch();
    logWithTimestamp(`✓ Twilio account verified: ${account.friendlyName} (${account.status.toUpperCase()})`);
    
    logWithTimestamp('Testing phone number configuration...');
    const phoneNumber = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1
    });
    
    if (phoneNumber.length > 0) {
      logWithTimestamp(`✓ From number verified: ${fromNumber} (${phoneNumber[0].friendlyName || 'No friendly name'})`);
      logWithTimestamp(`  Capabilities: SMS=${phoneNumber[0].capabilities.sms}, Voice=${phoneNumber[0].capabilities.voice}`);
    } else {
      logWithTimestamp(`⚠️  Could not verify phone number ${fromNumber} (may still work)`, 'WARN');
    }
    
    logWithTimestamp('✓ Twilio service connection successful');
    return true;
  } catch (error) {
    logWithTimestamp(`✗ Twilio connection test failed: ${error.message}`, 'ERROR');
    if (error.code) {
      logWithTimestamp(`  Twilio Error Code: ${error.code}`, 'ERROR');
    }
    if (error.status) {
      logWithTimestamp(`  HTTP Status: ${error.status}`, 'ERROR');
    }
    return false;
  }
}

async function sendSMSNotifications() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio credentials not found in environment variables');
  }

  logWithTimestamp('=== SENDING SMS NOTIFICATIONS ===');
  logWithTimestamp(`Message: "${CONFIG.message}"`);
  logWithTimestamp(`From: ${fromNumber}`);
  logWithTimestamp(`Recipients: ${CONFIG.phoneNumbers.length} numbers`);

  const client = twilio(accountSid, authToken);
  const results = [];
  let successCount = 0;

  for (const phoneNumber of CONFIG.phoneNumbers) {
    const maskedNumber = `***-***-${phoneNumber.slice(-4)}`;
    try {
      logWithTimestamp(`Sending SMS to ${maskedNumber}...`);
      const startTime = Date.now();
      
      const message = await client.messages.create({
        body: CONFIG.message,
        from: fromNumber,
        to: `+1${phoneNumber}`
      });
      
      const endTime = Date.now();
      logWithTimestamp(`✓ SMS sent to ${maskedNumber} in ${endTime - startTime}ms`);
      logWithTimestamp(`  Message SID: ${message.sid}`);
      logWithTimestamp(`  Status: ${message.status}`);
      logWithTimestamp(`  Direction: ${message.direction}`);
      
      if (message.price) {
        logWithTimestamp(`  Cost: ${message.price} ${message.priceUnit || 'USD'}`);
      }
      
      results.push({ 
        phoneNumber: maskedNumber, 
        success: true, 
        sid: message.sid,
        status: message.status,
        timeTaken: endTime - startTime
      });
      successCount++;
      
    } catch (error) {
      logWithTimestamp(`✗ Failed to send SMS to ${maskedNumber}: ${error.message}`, 'ERROR');
      if (error.code) {
        logWithTimestamp(`  Twilio Error Code: ${error.code}`, 'ERROR');
      }
      if (error.status) {
        logWithTimestamp(`  HTTP Status: ${error.status}`, 'ERROR');
      }
      if (error.moreInfo) {
        logWithTimestamp(`  More info: ${error.moreInfo}`, 'ERROR');
      }
      
      results.push({ 
        phoneNumber: maskedNumber, 
        success: false, 
        error: error.message,
        code: error.code,
        status: error.status
      });
    }
  }

  logWithTimestamp(`=== SMS NOTIFICATION SUMMARY ===`);
  logWithTimestamp(`Successfully sent: ${successCount} of ${CONFIG.phoneNumbers.length} messages`);
  logWithTimestamp(`Success rate: ${((successCount / CONFIG.phoneNumbers.length) * 100).toFixed(1)}%`);
  
  return results;
}

async function runDeploymentHealthCheck() {
  logWithTimestamp('🚀 === DEPLOYMENT HEALTH CHECK ===');
  let allHealthy = true;
  const healthResults = {};
  
  // 1. Environment validation
  logWithTimestamp('1️⃣ Testing environment configuration...');
  const envValid = validateEnvironmentAndLog();
  healthResults.environment = envValid;
  if (!envValid) allHealthy = false;
  
  // 2. Weather API test
  logWithTimestamp('2️⃣ Testing weather API connection...');
  try {
    const weatherData = await getWeatherData();
    if (weatherData && weatherData.length > 0) {
      logWithTimestamp('✅ Weather API test successful');
      healthResults.weatherAPI = true;
    } else {
      logWithTimestamp('❌ Weather API returned no data', 'ERROR');
      healthResults.weatherAPI = false;
      allHealthy = false;
    }
  } catch (error) {
    logWithTimestamp(`❌ Weather API test failed: ${error.message}`, 'ERROR');
    healthResults.weatherAPI = false;
    allHealthy = false;
  }
  
  // 3. Twilio connection test
  logWithTimestamp('3️⃣ Testing Twilio service connection...');
  const twilioHealthy = await testTwilioConnection();
  healthResults.twilio = twilioHealthy;
  if (!twilioHealthy) allHealthy = false;
  
  // 4. System resources check
  logWithTimestamp('4️⃣ Checking system resources...');
  const memUsage = process.memoryUsage();
  const memUsageMB = {
    rss: (memUsage.rss / 1024 / 1024).toFixed(2),
    heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
    heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(2),
    external: (memUsage.external / 1024 / 1024).toFixed(2)
  };
  
  logWithTimestamp(`Memory usage: RSS=${memUsageMB.rss}MB, Heap=${memUsageMB.heapUsed}/${memUsageMB.heapTotal}MB, External=${memUsageMB.external}MB`);
  
  const uptimeSeconds = process.uptime();
  logWithTimestamp(`Process uptime: ${uptimeSeconds.toFixed(1)} seconds`);
  
  healthResults.systemResources = {
    memory: memUsageMB,
    uptime: uptimeSeconds
  };
  
  // 5. Final health summary
  logWithTimestamp('🏁 === DEPLOYMENT HEALTH CHECK SUMMARY ===');
  logWithTimestamp(`Overall health status: ${allHealthy ? '✅ HEALTHY' : '❌ ISSUES DETECTED'}`);
  logWithTimestamp(`Environment: ${healthResults.environment ? '✅' : '❌'}`);
  logWithTimestamp(`Weather API: ${healthResults.weatherAPI ? '✅' : '❌'}`);
  logWithTimestamp(`Twilio Service: ${healthResults.twilio ? '✅' : '❌'}`);
  logWithTimestamp(`System Resources: ✅`);
  
  if (allHealthy) {
    logWithTimestamp('🎉 All services are operational! Pool Time app is ready for monitoring.');
  } else {
    logWithTimestamp('⚠️  Some services have issues. Please check the logs above for details.', 'WARN');
  }
  
  return { healthy: allHealthy, results: healthResults };
}

async function checkWeatherAndNotify() {
  try {
    logWithTimestamp('Checking weather conditions...');
    const weatherData = await getWeatherData();
    
    if (checkConsecutiveSunnyHours(weatherData)) {
      logWithTimestamp('Pool time conditions met! Sending notifications...');
      const smsResults = await sendSMSNotifications();
      const successCount = smsResults.filter(r => r.success).length;
      logWithTimestamp(`Successfully sent ${successCount} of ${smsResults.length} SMS notifications`);
      return true;
    } else {
      logWithTimestamp('Not enough consecutive sunny hours for pool time');
      return false;
    }
  } catch (error) {
    logWithTimestamp(`Error checking weather: ${error.message}`, 'ERROR');
    if (error.stack) {
      logWithTimestamp(`Stack trace: ${error.stack}`, 'ERROR');
    }
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

// Enhanced system monitoring
function getSystemInfo() {
  const memUsage = process.memoryUsage();
  return {
    uptime: process.uptime(),
    memory: {
      rss: (memUsage.rss / 1024 / 1024).toFixed(2),
      heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
      heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(2),
      external: (memUsage.external / 1024 / 1024).toFixed(2)
    },
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid
  };
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
    logWithTimestamp(`Error in scheduled weather check: ${error.message}`, 'ERROR');
    if (error.stack) {
      logWithTimestamp(`Stack trace: ${error.stack}`, 'ERROR');
    }
  }
}

// Heartbeat logging to show app is alive
function startHeartbeat() {
  // Log heartbeat every 30 minutes
  setInterval(() => {
    const sysInfo = getSystemInfo();
    logWithTimestamp(`💓 HEARTBEAT - Uptime: ${(sysInfo.uptime / 60).toFixed(1)}min, Memory: ${sysInfo.memory.heapUsed}MB`);
    
    // Log additional system info every 2 hours (4 heartbeats)
    const heartbeatCount = Math.floor(sysInfo.uptime / 1800); // Every 30min
    if (heartbeatCount % 4 === 0 && heartbeatCount > 0) {
      logWithTimestamp('📊 Extended system info:');
      logWithTimestamp(`  Platform: ${sysInfo.platform}`);
      logWithTimestamp(`  Node.js: ${sysInfo.nodeVersion}`);
      logWithTimestamp(`  PID: ${sysInfo.pid}`);
      logWithTimestamp(`  Memory - RSS: ${sysInfo.memory.rss}MB, Heap: ${sysInfo.memory.heapUsed}/${sysInfo.memory.heapTotal}MB`);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

// Main startup sequence
async function startApplication() {
  logWithTimestamp('🌊 === POOL TIME WEATHER NOTIFICATION APP ===');
  logWithTimestamp(`Monitoring weather for: The Woodlands, TX (${CONFIG.location.lat}, ${CONFIG.location.lon})`);
  logWithTimestamp(`Target: ${CONFIG.requiredSunnyHours} consecutive sunny hours between ${CONFIG.timeWindow.start}:00-${CONFIG.timeWindow.end}:00`);
  logWithTimestamp(`Recipients: ${CONFIG.phoneNumbers.length} phone numbers`);
  
  // Run deployment health check
  const healthCheck = await runDeploymentHealthCheck();
  
  if (!healthCheck.healthy) {
    logWithTimestamp('⚠️  Health check failed, but continuing startup. Monitor logs for issues.', 'WARN');
  }
  
  // Schedule weather checks every hour from 1pm to 6pm
  cron.schedule('0 13-18 * * *', scheduledWeatherCheck);
  logWithTimestamp('✅ Scheduled hourly weather checks from 1pm to 6pm');
  
  // Start heartbeat monitoring
  startHeartbeat();
  logWithTimestamp('💓 Started heartbeat monitoring (every 30 minutes)');
  
  // Handle process termination gracefully
  process.on('SIGINT', () => {
    logWithTimestamp('Received SIGINT, shutting down gracefully...', 'WARN');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    logWithTimestamp('Received SIGTERM, shutting down gracefully...', 'WARN');
    process.exit(0);
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logWithTimestamp(`Uncaught exception: ${error.message}`, 'ERROR');
    logWithTimestamp(`Stack trace: ${error.stack}`, 'ERROR');
    logWithTimestamp('Application will continue running, but this should be investigated', 'WARN');
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logWithTimestamp(`Unhandled promise rejection at: ${promise}`, 'ERROR');
    logWithTimestamp(`Reason: ${reason}`, 'ERROR');
  });
  
  // Run an initial weather check
  logWithTimestamp('🔍 Running initial weather check...');
  await scheduledWeatherCheck();
  
  logWithTimestamp('🚀 Pool Time app initialization complete! Monitoring active.');
}

// Start the application
startApplication().catch(error => {
  logWithTimestamp(`Failed to start application: ${error.message}`, 'ERROR');
  if (error.stack) {
    logWithTimestamp(`Stack trace: ${error.stack}`, 'ERROR');
  }
  process.exit(1);
});