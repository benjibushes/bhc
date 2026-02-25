import Airtable from 'airtable';

// Initialize Airtable
const apiKey = process.env.AIRTABLE_API_KEY;
const baseId = process.env.AIRTABLE_BASE_ID;

if (!apiKey || !baseId) {
  console.warn('Airtable API Key or Base ID is missing. Airtable client may not function correctly.');
}

const airtable = new Airtable({ apiKey: apiKey || 'dummy_key' });
const base = airtable.base(baseId || 'dummy_base');

// Table names
export const TABLES = {
  CONSUMERS: 'Consumers',
  RANCHERS: 'Ranchers',
  BRANDS: 'Brands',
  LAND_DEALS: 'Land Deals',
  NEWS_POSTS: 'News',
  INQUIRIES: 'Inquiries',
  CAMPAIGNS: 'Campaigns',
  REFERRALS: 'Referrals',
};

// Helper function to create a record
export async function createRecord(tableName: string, fields: any) {
  try {
    const records = await base(tableName).create([{ fields }]);
    return records[0];
  } catch (error) {
    console.error(`Error creating record in ${tableName}:`, error);
    throw error;
  }
}

// Helper function to get all records from a table
export async function getAllRecords(tableName: string, filterByFormula?: string) {
  try {
    const records = await base(tableName)
      .select({
        ...(filterByFormula && { filterByFormula }),
      })
      .all();
    
    return records.map((record) => ({
      id: record.id,
      ...record.fields,
    }));
  } catch (error) {
    console.error(`Error fetching records from ${tableName}:`, error);
    throw error;
  }
}

// Helper function to get a single record by ID
export async function getRecordById(tableName: string, recordId: string) {
  try {
    const record = await base(tableName).find(recordId);
    return {
      id: record.id,
      ...record.fields,
    };
  } catch (error) {
    console.error(`Error fetching record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

// Alias for consistency
export async function getRecord(tableName: string, recordId: string) {
  try {
    const record = await base(tableName).find(recordId);
    return {
      id: record.id,
      fields: record.fields,
    };
  } catch (error) {
    console.error(`Error fetching record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

// Helper function to update a record
export async function updateRecord(tableName: string, recordId: string, fields: any) {
  try {
    const records = await base(tableName).update([
      {
        id: recordId,
        fields,
      },
    ]);
    return {
      id: records[0].id,
      ...records[0].fields,
    };
  } catch (error) {
    console.error(`Error updating record ${recordId} in ${tableName}:`, error);
    throw error;
  }
}

// Helper function to delete a record
export async function deleteRecord(tableName: string, recordId: string) {
  try {
    const deletedRecords = await base(tableName).destroy([recordId]);
    return deletedRecords[0];
  } catch (error) {
    console.error(`Error deleting record ${recordId} from ${tableName}:`, error);
    throw error;
  }
}

export default base;


