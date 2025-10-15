# Bus Ticket Booking REST API

A RESTful API for bus ticket booking system, built with Node.js, Express, and Supabase.

## Features

- Search for trips between cities with date filtering
- Get detailed trip information including routes, buses, and availability
- Book tickets with automated seat management
- Payment processing integration (placeholder)
- Comprehensive route management
- Real-time seat availability tracking

## API Endpoints

### Authentication

#### User Login
```
POST /api/auth/login
```

Request Body:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Response:
```json
{
  "success": true,
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "role": "passenger",
    "first_name": "John",
    "last_name": "Doe",
    "phone_number": "+244900123456"
  },
  "session": {
    "access_token": "jwt-token",
    "refresh_token": "refresh-token",
    "expires_at": 1668547200
  }
}
```

#### User Registration
```
POST /api/auth/register
```

Request Body:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "firstName": "John",
  "lastName": "Doe",
  "role": "passenger"
}
```

#### Get Current User Profile
```
GET /api/auth/me
Authorization: Bearer <access_token>
```

#### User Logout
```
POST /api/auth/logout
```

### Trip Management

#### Search for Trips
```
GET /api/trips
```

Query Parameters:
- `origin` (string): Origin city name
- `destination` (string): Destination city name
- `date` (string): Date in YYYY-MM-DD format
- `class` (string): Seat class (economy, business, first)
- `sort` (string): Sort field (default: departure_time)
- `order` (string): Sort order (asc, desc) (default: asc)
- `limit` (number): Number of results (default: 50)
- `offset` (number): Pagination offset (default: 0)

#### Get Specific Trip
```
GET /api/trips/:tripId
```

#### Get Available Routes
```
GET /api/routes?active=true
```

### Booking

#### Book a Trip
```
POST /api/booking
```

Request Body:
```json
{
  "tripId": "trip-uuid",
  "passengerId": "passenger-uuid",
  "seatNumber": 15,
  "seatClass": "economy",
  "paymentMethod": "card",
  "paymentReference": "txn-12345"
}
```

### Payment

#### Process Payment
```
POST /api/payment
```

### Health Check
```
GET /api/health
```

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Copy `.env` file and configure your Supabase credentials:
```
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key
PORT=5000
```

4. Start the server:
```bash
npm start
```

## Database Schema

The API expects a Supabase database with the following tables:
- `trips` - Trip information
- `routes` - Route definitions
- `buses` - Bus information
- `companies` - Bus companies
- `tickets` - Booked tickets
- `profiles` - User profiles
- `payment_transactions` - Payment records

## Response Format

All API responses follow this structure:
```json
{
  "success": true,
  "data": {},
  "error": null
}
```

## Error Handling

The API returns appropriate HTTP status codes:
- `200` - Success
- `400` - Bad Request
- `404` - Not Found
- `500` - Internal Server Error

## Testing Example

Search for trips from Luanda to Benguela on a specific date:
```
GET /api/trips?origin=Luanda&destination=Benguela&date=2025-10-15
```

Book a seat:
```
POST /api/booking
Content-Type: application/json

{
  "tripId": "550e8400-e29b-41d4-a716-446655440123",
  "passengerId": "550e8400-e29b-41d4-a716-446655440456",
  "seatNumber": 15,
  "paymentMethod": "card",
  "paymentReference": "txn_test_12345"
}
