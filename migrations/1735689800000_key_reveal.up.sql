-- Lets the admin view/copy a full issued key at any time, not just once at
-- creation. Encrypted (not plaintext) at rest so a raw DB dump alone still
-- doesn't hand out every customer's live key -- decryption key is
-- SESSION_SECRET, which lives only in Railway env vars, not this database.
ALTER TABLE reseller_api_keys ADD COLUMN key_ciphertext text;
