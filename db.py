"""
Database module for the Interactive History Platform.
Handles all database operations for storing landmarks, historical texts, AI-generated answers, and evaluation metrics.
"""

import sqlite3
import json
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / 'cache.db'


class Database:
    """A wrapper class for database operations that manages the SQLite connection and queries."""

    def __init__(self, path=None):
        """Initialize the database with an optional custom path."""
        self.path = path or str(DB_PATH)
        self.initialize_database_tables()

    def get_database_connection(self):
        """Create and return a new database connection."""
        database_connection = sqlite3.connect(self.path)
        database_connection.row_factory = sqlite3.Row
        return database_connection

    def initialize_database_tables(self):
        """Create all required database tables if they don't already exist."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()

        database_cursor.execute('''
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

        database_cursor.execute('''
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

        database_cursor.execute('''
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

        database_cursor.execute('''
            CREATE TABLE IF NOT EXISTS evaluation_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_name TEXT NOT NULL,
                landmark_id TEXT,
                metric_name TEXT NOT NULL,
                metric_value REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        database_cursor.execute('''
            CREATE TABLE IF NOT EXISTS statistics (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        database_connection.commit()
        database_connection.close()

    def save_landmark_to_database(self, landmark_data):
        """Save or update a landmark in the database."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                INSERT OR REPLACE INTO landmarks
                (id, name, lat, lon, osm_type, osm_id, tags, wikidata_id, wikipedia_url, retrieved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                landmark_data['id'],
                landmark_data['name'],
                landmark_data['lat'],
                landmark_data['lon'],
                landmark_data.get('osmType'),
                landmark_data.get('osmId'),
                json.dumps(landmark_data.get('tags', {})),
                landmark_data.get('wikidata'),
                landmark_data.get('wikipedia'),
                datetime.utcnow().isoformat(),
            ))
            database_connection.commit()
            return True
        except Exception as error:
            print(f"Error saving landmark to database: {error}")
            return False
        finally:
            database_connection.close()

    def retrieve_landmark_by_id(self, landmark_id):
        """Retrieve a landmark by its ID."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('SELECT * FROM landmarks WHERE id = ?', (landmark_id,))
            retrieved_row = database_cursor.fetchone()
            return dict(retrieved_row) if retrieved_row else None
        finally:
            database_connection.close()

    def retrieve_landmarks_by_geographic_area(self, latitude, longitude, radius_in_kilometers=1):
        """Retrieve all landmarks within a certain radius of a location."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                SELECT * FROM landmarks
                WHERE ABS(lat - ?) < ? AND ABS(lon - ?) < ?
            ''', (latitude, radius_in_kilometers / 111, longitude, radius_in_kilometers / 111))
            
            landmarks_list = []
            for retrieved_row in database_cursor.fetchall():
                landmarks_list.append(dict(retrieved_row))
            return landmarks_list
        finally:
            database_connection.close()

    def save_historical_text_for_landmark(self, landmark_id, text_content=None, source_provider=None, source_url=None, retrieval_status='success', error_message=None):
        """Save historical text retrieved for a landmark."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                INSERT INTO historical_texts
                (landmark_id, text, source, source_url, retrieval_status, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (
                landmark_id,
                text_content,
                source_provider,
                source_url,
                retrieval_status,
                error_message,
            ))
            database_connection.commit()
            return True
        except Exception as error:
            print(f"Error saving historical text: {error}")
            return False
        finally:
            database_connection.close()

    def get_latest_historical_text_for_landmark(self, landmark_id):
        """Get the most recently retrieved historical text for a landmark."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                SELECT * FROM historical_texts
                WHERE landmark_id = ?
                ORDER BY retrieved_at DESC LIMIT 1
            ''', (landmark_id,))
            retrieved_row = database_cursor.fetchone()
            return dict(retrieved_row) if retrieved_row else None
        finally:
            database_connection.close()

    def save_generated_answer_for_landmark(self, landmark_id, user_question, generated_answer=None, year_filter=None, generation_status='success', error_message=None, model_name='ollama-llama2', temperature_value=0.3):
        """Save an AI-generated answer about a landmark."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                INSERT INTO generated_answers
                (landmark_id, question, year, answer, generation_status, error_message, model_used, temperature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (landmark_id, user_question, year_filter, generated_answer, generation_status, error_message, model_name, temperature_value))
            database_connection.commit()
            return True
        except Exception as error:
            print(f"Error saving generated answer: {error}")
            return False
        finally:
            database_connection.close()

    def retrieve_answer_for_landmark(self, landmark_id, user_question, year_filter=None):
        """Retrieve the most recent answer for a specific question about a landmark."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                SELECT * FROM generated_answers
                WHERE landmark_id = ? AND question = ? AND year IS ?
                ORDER BY generated_at DESC LIMIT 1
            ''', (landmark_id, user_question, year_filter))
            retrieved_row = database_cursor.fetchone()
            return dict(retrieved_row) if retrieved_row else None
        finally:
            database_connection.close()

    def save_evaluation_results(self, test_name, results_data):
        """Save evaluation test results to the database."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            for metric_key, metric_value in results_data.items():
                database_cursor.execute('''
                    INSERT INTO evaluation_metrics (test_name, metric_name, metric_value)
                    VALUES (?, ?, ?)
                ''', (test_name, metric_key, metric_value))
            database_connection.commit()
        finally:
            database_connection.close()

    def retrieve_evaluation_results(self, test_name=None):
        """Retrieve evaluation test results, optionally filtered by test name."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            if test_name:
                database_cursor.execute('SELECT * FROM evaluation_metrics WHERE test_name = ?', (test_name,))
            else:
                database_cursor.execute('SELECT * FROM evaluation_metrics')
            retrieved_rows = database_cursor.fetchall()
            return [dict(row) for row in retrieved_rows] if retrieved_rows else []
        finally:
            database_connection.close()

    def update_statistic_value(self, statistic_key, statistic_value):
        """Save or update a statistic value."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('''
                INSERT OR REPLACE INTO statistics (key, value)
                VALUES (?, ?)
            ''', (statistic_key, str(statistic_value)))
            database_connection.commit()
        finally:
            database_connection.close()

    def retrieve_statistic_value(self, statistic_key):
        """Retrieve a statistic value by its key."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('SELECT value FROM statistics WHERE key = ?', (statistic_key,))
            retrieved_row = database_cursor.fetchone()
            return retrieved_row['value'] if retrieved_row else None
        finally:
            database_connection.close()

    def clear_all_database_content(self):
        """Delete all data from the database tables (used for testing/reset)."""
        database_connection = self.get_database_connection()
        database_cursor = database_connection.cursor()
        try:
            database_cursor.execute('DELETE FROM evaluation_metrics')
            database_cursor.execute('DELETE FROM generated_answers')
            database_cursor.execute('DELETE FROM historical_texts')
            database_cursor.execute('DELETE FROM landmarks')
            database_connection.commit()
        finally:
            database_connection.close()
