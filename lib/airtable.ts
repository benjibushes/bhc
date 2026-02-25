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
  REFERRALS: 'referrals',
};

// Helper function to create a record (auto-strips problematic Airtable fields)
export async function createRecord(tableName: string, fields: any) {
  let currentFields = { ...fields };
  const maxRetries = 8;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const records = await base(tableName).create([{ fields: currentFields }]);
      return records[0];
    } catch (error: any) {
      const msg = error?.message || error?.error?.message || String(error);

      const unknownField = msg.match(/Unknown field name: "([^"]+)"/);
      if (unknownField && attempt < maxRetries) {
        console.warn(`Airtable: stripping unknown field "${unknownField[1]}" from ${tableName}`);
        delete currentFields[unknownField[1]];
        continue;
      }

      const selectErr = msg.match(/Insufficient permissions to create new select option "([^"]*)"/) ||
                         msg.match(/Insufficient permissions to create new select option ""([^"]*)""/) ;
      if (selectErr && attempt < maxRetries) {
        const badValue = selectErr[1];
        const badKey = Object.keys(currentFields).find(k => String(currentFields[k]) === badValue);
        if (badKey) {
          console.warn(`Airtable: stripping field "${badKey}" with invalid select value from ${tableName}`);
          delete currentFields[badKey];
          continue;
        }
      }

      if (msg.includes('Insufficient permissions') && msg.includes('select option') && attempt < maxRetries) {
        const fieldWithIssue = Object.keys(currentFields).find(k =>
          typeof currentFields[k] === 'string' && currentFields[k].length > 0 &&
          !['Full Name', 'Email', 'Phone', 'State', 'Notes', 'Ranch Name', 'Operator Name',
            'Buyer Name', 'Buyer Email', 'Buyer Phone', 'Buyer State', 'Suggested Rancher Name',
            'Suggested Rancher State', 'Description', 'Operation Details', 'Certifications'].includes(k)
        );
        if (fieldWithIssue) {
          console.warn(`Airtable: stripping suspected select field "${fieldWithIssue}" from ${tableName}`);
          delete currentFields[fieldWithIssue];
          continue;
        }
      }

      console.error(`Error creating record in ${tableName}:`, error);
      throw error;
    }
  }
  throw new Error(`Failed to create record in ${tableName} after ${maxRetries} retries`);
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

// Helper function to update a record (auto-strips problematic Airtable fields)
export async function updateRecord(tableName: string, recordId: string, fields: any) {
  let currentFields = { ...fields };
  const maxRetries = 8;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const records = await base(tableName).update([
        {
          id: recordId,
          fields: currentFields,
        },
      ]);
      return {
        id: records[0].id,
        ...records[0].fields,
      };
    } catch (error: any) {
      const msg = error?.message || error?.error?.message || String(error);

      const unknownField = msg.match(/Unknown field name: "([^"]+)"/);
      if (unknownField && attempt < maxRetries) {
        console.warn(`Airtable: stripping unknown field "${unknownField[1]}" from ${tableName} update`);
        delete currentFields[unknownField[1]];
        continue;
      }

      const badValueField = msg.match(/Field "([^"]+)" cannot accept/);
      if (badValueField && attempt < maxRetries) {
        console.warn(`Airtable: stripping incompatible field "${badValueField[1]}" from ${tableName} update`);
        delete currentFields[badValueField[1]];
        continue;
      }

      const selectErr = msg.match(/Insufficient permissions to create new select option/);
      if (selectErr && attempt < maxRetries) {
        const fieldWithIssue = Object.keys(currentFields).find(k =>
          typeof currentFields[k] === 'string' && currentFields[k].length > 0
        );
        if (fieldWithIssue) {
          console.warn(`Airtable: stripping select field "${fieldWithIssue}" from ${tableName} update`);
          delete currentFields[fieldWithIssue];
          continue;
        }
      }

      console.error(`Error updating record ${recordId} in ${tableName}:`, error);
      throw error;
    }
  }
  throw new Error(`Failed to update record in ${tableName} after ${maxRetries} retries`);
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


