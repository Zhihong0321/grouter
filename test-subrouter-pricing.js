// Test SubRouter pricing endpoint
const SUBROUTER_BASE_URL = process.env.SUBROUTER_BASE_URL || 'https://subrouter.ai';
const SUBROUTER_SESSION = process.env.SUBROUTER_SESSION;
const SUBROUTER_USER_ID = process.env.SUBROUTER_USER_ID;

async function testPricingEndpoint() {
  console.log('Testing SubRouter Pricing API');
  console.log('Base URL:', SUBROUTER_BASE_URL);
  console.log('');

  try {
    const response = await fetch(`${SUBROUTER_BASE_URL}/api/pricing`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': `session=${SUBROUTER_SESSION}`,
        'New-Api-User': SUBROUTER_USER_ID,
      },
    });

    const json = await response.json();
    console.log(`Status: ${response.status}`);
    console.log(`Success: ${json.success !== false}`);
    console.log(`Total models: ${json.data?.length || 0}`);
    console.log('');

    if (json.data && json.data.length > 0) {
      console.log('Sample model pricing (first 3):');
      console.log('='.repeat(80));
      json.data.slice(0, 3).forEach(model => {
        console.log(`Model: ${model.model_name}`);
        console.log(`  Input Price: $${model.official_input_price} per million tokens`);
        console.log(`  Output Price: $${model.official_output_price} per million tokens`);
        console.log(`  Vendor ID: ${model.vendor_id}`);
        console.log(`  Supports Cache: ${model.supports_cache_read}`);
        console.log('');
      });

      // Find Claude models
      console.log('Claude models:');
      console.log('='.repeat(80));
      const claudeModels = json.data.filter(m => m.model_name.includes('claude'));
      claudeModels.slice(0, 5).forEach(model => {
        console.log(`${model.model_name}: $${model.official_input_price}/$${model.official_output_price} per million`);
      });
    }
  } catch (error) {
    console.error(`Error:`, error.message);
  }
}

testPricingEndpoint();
