"""
Database module for the Interactive History Platform.
Handles all database operations for storing landmarks, historical texts, AI-generated answers, and evaluation metrics.
"""

# Import the sqlite3 library for working with SQLite databases
import sqlite3

# Import json for converting Python objects to/from JSON format
import json

# Import datetime for timestamps
from datetime import datetime

# Import Path for working with file paths in a cross-platform way
from pathlib import Path

# Set the database file path to be in the same directory as this script
DB_PATH = Path(__file__).parent / 'cache.db'


class Database:
    """A wrapper class for database operations that manages the SQLite connection and queries."""

    def __init__(self, path=None):
        """Initialize the database with an optional custom path."""
        # Use the provided path or the default DB_PATH
        self.path = path or str(DB_PATH)
        # Create the database tables if they don't exist yet
        self.init_db()

    def get_conn(self):
        """Create and return a new database connection."""
        # Connect to the SQLite database file
        conn = sqlite3.connect(self.path)
        # Set row_factory to return rows as dictionary-like objects instead of tuples
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self):
        """Create all required database tables if they don't already exist."""
        conn = self.get_conn()
        c = conn.cursor()

        c.execute('''
            CREATE TABLE IF NOT EXISTS landmarks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                osm_type TEXT,
                osm_id INTEGER,
                tags JSON,
                wikidata_id TEXT,
                wikipedia_url TEXT,
                retrieved_at TIMESTAMP,
                UNIQUE(osm_type, osm_id)
            )
        ''')

        c.execute('''
            CREATE TABLE IF NOT EXISTS historical_texts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                landmark_id TEXT NOT NULL,
                text TEXT,
                source TEXT,
                source_url TEXT,
                retrieval_status TEXT,
                error_message TEXT,
                retrieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (landmark_id) REFERENCES landmarks(id)
            )
        ''')

        c.execute('''
            CREATE TABLE IF NOT EXISTS generated_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                landmark_id TEXT NOT NULL,
                question TEXT NOT NULL,
                year INTEGER,
                answer TEXT,
                generation_status TEXT,
                error_message TEXT,
                model_used TEXT,
                temperature REAL,
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (landmark_id) REFERENCES landmarks(id)
            )
        ''')

        c.execute('''
            CREATE TABLE IF NOT EXISTS evaluation_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_name TEXT NOT NULL,
                landmark_id TEXT,
                metric_name TEXT NOT NULL,
                metric_value REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        c.execute('''
            CREATE TABLE IF NOT EXISTS statistics (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        conn.commit()
        conn.close()

    def save_landmark(self, lm):
        """Save or update a landmark in the database."""
        # Get a database connection
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Insert or replace the landmark record
            c.execute('''
                INSERT OR REPLACE INTO landmarks
                (id, name, lat, lon, osm_type, osm_id, tags, wikidata_id, wikipedia_url, retrieved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                lm['id'],                          # Unique landmark identifier
                lm['name'],                        # Landmark name
                lm['lat'],                         # Latitude coordinate
                lm['lon'],                         # Longitude coordinate
                lm.get('osmType'),                 # OSM type (node/way/relation)
                lm.get('osmId'),                   # OSM ID number
                json.dumps(lm.get('tags', {})),    # Tags as JSON string
                lm.get('wikidata'),                # Wikidata ID if available
                lm.get('wikipedia'),               # Wikipedia URL if available
                datetime.utcnow().isoformat(),     # Current timestamp
            ))
            conn.commit()
            return True
        except Exception as e:
            print(f"save landmark error: {e}")
            return False
        finally:
            conn.close()

    def get_landmark(self, lm_id):
        """Retrieve a landmark by its ID."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Query for the landmark with the matching ID
            c.execute('SELECT * FROM landmarks WHERE id = ?', (lm_id,))
            row = c.fetchone()
            # Convert the database row to a dictionary if found, otherwise return None
            return dict(row) if row else None
        finally:
            conn.close()

    def get_landmarks_by_location(self, lat, lon, radius_km=1):
        """Retrieve all landmarks within a certain radius of a location."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Query for landmarks where the latitude and longitude are within the radius
            # (Using simple rectangular search; 1 degree latitude/longitude ≈ 111 km)
            c.execute('''
                SELECT * FROM landmarks
                WHERE ABS(lat - ?) < ? AND ABS(lon - ?) < ?
            ''', (lat, radius_km / 111, lon, radius_km / 111))
            
            # Convert all rows to dictionaries and return as a list
            results = []
            for row in c.fetchall():
                results.append(dict(row))
            return results
        finally:
            conn.close()

    def save_historical_text(self, lm_id, text=None, source=None, url=None, status='success', error=None):
        """Save historical text retrieved for a landmark."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Insert a new row into the historical_texts table
            c.execute('''
                INSERT INTO historical_texts
                (landmark_id, text, source, source_url, retrieval_status, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                lm_id,     # Which landmark this text is about
                text,      # The actual text content
                source,    # Where it came from (Wikipedia, Wikidata, etc.)
                url,       # URL to the source
                status,    # Success or error status
                error,     # Error message if status is error
            ))
            conn.commit()
            return True
        except Exception as e:
            print(f"save text error: {e}")
            return False
        finally:
            conn.close()

    def get_latest_text(self, lm_id):
        """Get the most recently retrieved historical text for a landmark."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Query the historical text for this landmark, ordered by most recent first
            c.execute('''
                SELECT * FROM historical_texts
                WHERE landmark_id = ?
                ORDER BY retrieved_at DESC LIMIT 1
            ''', (lm_id,))
            row = c.fetchone()
            # Convert the database row to a dictionary if found
            return dict(row) if row else None
        finally:
            conn.close()

    def save_answer(self, lm_id, question, answer=None, year=None, status='success', error=None, model='ollama-llama2', temp=0.3):
        """Save an AI-generated answer about a landmark."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            c.execute('''
                INSERT INTO generated_answers
                (landmark_id, question, year, answer, generation_status, error_message, model_used, temperature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (lm_id, question, year, answer, status, error, model, temp))
            conn.commit()
            return True
        except Exception as e:
            print(f"save answer error: {e}")
            return False
        finally:
            conn.close()

    def get_answer(self, lm_id, question, year=None):
        """Retrieve the most recent answer for a specific question about a landmark."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Query for the answer matching landmark, question, and optional year
            c.execute('''
                SELECT * FROM generated_answers
                WHERE landmark_id = ? AND question = ? AND year IS ?
                ORDER BY generated_at DESC LIMIT 1
            ''', (lm_id, question, year))
            row = c.fetchone()
            # Convert the database row to a dictionary if found
            return dict(row) if row else None
        finally:
            conn.close()

    def save_eval(self, test_name, res):
        """Save evaluation test results to the database."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            for key, val in res.items():
                c.execute('''
                    INSERT INTO evaluation_metrics (test_name, metric_name, metric_value)
                    VALUES (?, ?, ?)
                ''', (test_name, key, val))
            conn.commit()
        finally:
            conn.close()

    def get_eval_results(self, test_name=None):
        """Retrieve evaluation test results, optionally filtered by test name."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            if test_name:
                c.execute('SELECT * FROM evaluation_metrics WHERE test_name = ?', (test_name,))
            else:
                c.execute('SELECT * FROM evaluation_metrics')
            rows = c.fetchall()
            return [dict(row) for row in rows] if rows else []
        finally:
            conn.close()

    def update_stat(self, key, value):
        """Save or update a statistic value."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            c.execute('''
                INSERT OR REPLACE INTO statistics (key, value)
                VALUES (?, ?)
            ''', (key, str(value)))
            conn.commit()
        finally:
            conn.close()

    def get_stat(self, key):
        """Retrieve a statistic value by its key."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            c.execute('SELECT value FROM statistics WHERE key = ?', (key,))
            row = c.fetchone()
            return row['value'] if row else None
        finally:
            conn.close()

    def clear_all(self):
        """Delete all data from the database tables (used for testing/reset)."""
        conn = self.get_conn()
        c = conn.cursor()
        try:
            # Delete all rows from each table
            c.execute('DELETE FROM evaluation_metrics')
            c.execute('DELETE FROM generated_answers')
            c.execute('DELETE FROM historical_texts')
            c.execute('DELETE FROM landmarks')
            conn.commit()
        finally:
            conn.close()
