# ReadMe MVP API Contract (REST)

Base URL: configurable in extension Options (default: http://localhost:8080)

## Auth
### POST /auth/register (optional for MVP)
Body:
{
  "email": "user@example.com",
  "password": "string"
}

### POST /auth/login
Body:
{
  "email": "user@example.com",
  "password": "string"
}
Response:
{
  "access_token": "jwt-string",
  "user": { "id": "u_123", "email": "user@example.com" }
}

## Conversations
### GET /conversations
Header: Authorization: Bearer <token>
Response:
[
  { "id": "c_1", "title": "Test Chat", "last_message_id": 0 }
]

## Messages
### GET /messages?conversation_id=c_1&limit=50
Header: Authorization: Bearer <token>
Response:
[
  { "id": 1, "conversation_id": "c_1", "sender_id": "u_123", "text": "hello", "created_at": "..." }
]

### GET /messages?conversation_id=c_1&after_id=1
Header: Authorization: Bearer <token>
Response:
[
  { "id": 2, "conversation_id": "c_1", "sender_id": "u_456", "text": "hi", "created_at": "..." }
]

### POST /messages
Header: Authorization: Bearer <token>
Body:
{
  "conversation_id": "c_1",
  "text": "message text"
}
Response:
{ "id": 3 }
