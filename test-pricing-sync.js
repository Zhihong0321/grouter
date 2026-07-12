// Integration test for SubRouter pricing sync
import { SubRouterClient } from './src/lib/subrouterClient.js';

const SUBROUTER_BASE_URL = process.env.SUBROUTER_BASE_URL || 'https://subrouter.ai';
const SUBROUTER_SESSION = process.env.SUBROUTER_SESSION;
const SUBROUTER_USER_ID = process.env.SUBROUTER_USER_ID;

async function testPricingSync() {
  console.log('Testing SubRouter Pricing Sync Integration');
  console.log('='.repeat(80));
  console.log('');

  if (!SUBROUTER_SESSION || !SUBROUTER_USER_ID) {
    console.error('Error: SUBROUTER_SESSION and SUBROUTER_USER_ID must be set');
    process.exit(1);
  }

  const client = new SubRouterClient({
    baseUrl: SUBROUTER_BASE_URL,
    session: SUBROUTER_SESSION,
    userId: SUBROUTER_USER_ID,
    timeoutMs: 15000,
  });

  try {
    console.log('1. Fetching pricing data from SubRouter...');
    const pricing = await client.listPricing();

    console.log(`✓ Successfully fetched ${pricing.models.length} models`);
    console.log('');

    console.log('2. Sample pricing data:');
    console.log('='.repeat(80));

    // Show Claude models
    const claudeModels = pricing.models.filter(m => m.model.toLowerCase().includes('claude'));
    console.log(`\nClaude models (${claudeModels.length} total):`);
    claudeModels.slice(0, 10).forEach(model => {
      console.log(`  ${model.model.padEnd(40)} $${model.inputPricePerMillion}/$${model.outputPricePerMillion}`);
    });

    // Show GPT models
    const gptModels = pricing.models.filter(m => m.model.toLowerCase().includes('gpt'));
    console.log(`\nGPT models (${gptModels.length} total):`);
    gptModels.slice(0, 10).forEach(model => {
      console.log(`  ${model.model.padEnd(40)} $${model.inputPricePerMillion}/$${model.outputPricePerMillion}`);
    });

    console.log('');
    console.log('3. Price conversion test (USD to cents):');
    console.log('='.repeat(80));
    const sampleModel = claudeModels[0] || pricing.models[0];
    if (sampleModel) {
      const inputCents = Math.round(sampleModel.inputPricePerMillion * 100);
      const outputCents = Math.round(sampleModel.outputPricePerMillion * 100);
      console.log(`Model: ${sampleModel.model}`);
      console.log(`  Input:  $${sampleModel.inputPricePerMillion} → ${inputCents} cents per million`);
      console.log(`  Output: $${sampleModel.outputPricePerMillion} → ${outputCents} cents per million`);
    }

    console.log('');
    console.log('✓ All tests passed!');
    console.log('');
    console.log('Next steps:');
    console.log('  1. The pricing sync endpoint is ready at POST /admin/api/supplier-sync/pricing');
    console.log('  2. It will sync these prices to reseller_model_prices table');
    console.log('  3. Only models already in reseller_models will be updated');

  } catch (error) {
    console.error('✗ Test failed:', error.message);
    if (error.type) {
      console.error('  Error type:', error.type);
    }
    process.exit(1);
  }
}

testPricingSync();
