# Auth Testing Playbook

## Admin credentials (seeded)
- Email: `admin@creativemojo.co.uk`
- Password: `CreativeMojo2026!`
- Role: `admin`

## Backend smoke tests
```
# Login (saves cookies)
API=https://licensee-vault.preview.emergentagent.com
curl -c /tmp/cmojo.txt -X POST $API/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@creativemojo.co.uk","password":"CreativeMojo2026!"}'

# Me (uses cookies)
curl -b /tmp/cmojo.txt $API/api/auth/me

# Airtable tables
curl -b /tmp/cmojo.txt $API/api/airtable/tables

# Logout
curl -b /tmp/cmojo.txt -X POST $API/api/logout
```

## Database verification
```
mongosh
use creative_mojo_admin
db.users.find({role: "admin"})
```
- bcrypt hash must start with `$2b$`
- unique index must exist on `users.email`
