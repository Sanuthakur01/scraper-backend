import dns from 'node:dns';
import mongoose from 'mongoose';
import { config } from './config.js';

const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1'];

// A connection string without a database name ("...mongodb.net/?retryWrites...") would write to "test".
const hasDatabaseName = (uri) => {
  try {
    return new URL(uri).pathname.length > 1;
  } catch {
    return true; // Unusual URI format: leave it as the user wrote it.
  }
};

export async function connectDb(uri = config.mongoUri) {
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. On this PC: copy .env.example to .env and fill it in. On a host (Railway, Render): add it to the service\'s environment variables.',
    );
  }
  const options = {
    serverSelectionTimeoutMS: 15_000,
    ...(hasDatabaseName(uri) ? {} : { dbName: 'jobdashboard' }),
  };

  try {
    await mongoose.connect(uri, options);
  } catch (err) {
    // Some networks (VPNs, antivirus, office DNS filters) refuse the SRV lookup that
    // mongodb+srv:// addresses need. Retry once with public DNS for that lookup.
    if (!uri.startsWith('mongodb+srv://') || !/querySrv|queryTxt/.test(err.message)) throw err;
    console.warn(`MongoDB address lookup failed on this network (${err.code ?? err.message}); retrying with public DNS.`);
    dns.setServers(PUBLIC_DNS);
    await mongoose.connect(uri, options);
  }
  return mongoose.connection;
}

export const disconnectDb = () => mongoose.disconnect();
